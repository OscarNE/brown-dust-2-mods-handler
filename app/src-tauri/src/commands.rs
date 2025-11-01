use crate::catalog;
use crate::types::{AppSettings, CatalogReport, DraftMod, ScanSummary};
use anyhow::Result;
use deunicode::deunicode;
use fuzzy_matcher::skim::SkimMatcherV2;
use fuzzy_matcher::FuzzyMatcher;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use tauri::{Emitter, Window};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

use crate::db;
use crate::types::{ModFilter, ModRow, ModType, NewMod};

/* ===========Helpers=========== */

// quick tokenizer/slugger
fn norm_tokens(s: &str) -> Vec<String> {
    let clean = deunicode(&s.to_lowercase());
    clean
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(|t| t.to_string())
        .collect()
}

const DEFAULT_TYPE_ALIASES: &[(&str, &str)] = &[
    // gameplay "idle" equivalents
    ("idle", "idle"),
    ("standing", "idle"),
    ("stand", "idle"),
    ("idleanim", "idle"),
    ("loop", "idle"),
    ("lobby", "idle"),
    ("illustration", "idle"),
    ("illust", "idle"),
    // cutscenes
    ("burst", "cutscene"),
    ("cutscene", "cutscene"),
    ("cut", "cutscene"),
    ("cs", "cutscene"),
    ("skillcut", "cutscene"),
    ("stkillcut", "cutscene"),
    ("skullcut", "cutscene"),
    ("skillcit", "cutscene"),
    ("specialillustration", "cutscene"),
    ("specialillust", "cutscene"),
    // history
    ("history", "history"),
    ("story", "history"),
    ("plot", "history"),
    // date
    ("date", "date"),
    ("dating", "date"),
    // Minigame content
    ("minigame", "minigame"),
    // Different characters
    ("swap", "swap"),
];

const DEFAULT_AUTHOR_ALIASES: &[(&str, &str)] = &[
    ("mrmiagi", "MrMiagi"),
    // Add more aliases here as they become known
];

#[derive(Debug, Serialize)]
pub struct AuthorFolder {
    pub folder_path: String,
    pub inferred_author: String,
}

#[derive(Debug, Serialize)]
pub struct PreviewGenerationSummary {
    pub generated: usize,
    pub skipped: usize,
    pub errors: usize,
}

#[derive(Debug, Serialize)]
pub struct PreviewInfo {
    pub has_image: bool,
    pub has_video: bool,
    pub image_path: Option<String>,
    pub video_path: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
struct PreviewProgressEvent<'a> {
    kind: &'a str,
    status: &'a str,
    total: usize,
    processed: usize,
    generated: usize,
    skipped: usize,
    errors: usize,
    current_mod: Option<String>,
    message: Option<String>,
}

struct PreviewTarget {
    id: i64,
    display_name: String,
    folder_path: String,
}

fn infer_mod_type(folder_name: &str) -> ModType {
    let normalized = deunicode(&folder_name.to_lowercase());
    let sanitized: String = normalized.chars().filter(|c| c.is_alphanumeric()).collect();
    if sanitized.is_empty() {
        return ModType::Other;
    }

    let mut best_match: Option<(&str, &str)> = None;
    for (alias, ty) in DEFAULT_TYPE_ALIASES.iter().copied() {
        if sanitized.contains(alias) {
            match best_match {
                Some((prev_alias, _)) if prev_alias.len() >= alias.len() => continue,
                _ => best_match = Some((alias, ty)),
            }
        }
    }

    if let Some((_, ty)) = best_match {
        return ModType::from_str(ty);
    }
    ModType::Other
}

fn infer_author_name(folder_name: &str) -> String {
    let normalized = deunicode(&folder_name.to_lowercase());
    let sanitized: String = normalized.chars().filter(|c| c.is_alphanumeric()).collect();
    if sanitized.is_empty() {
        return "unknown".to_string();
    }

    let mut best_match: Option<(&str, &str)> = None;
    for (alias, canonical) in DEFAULT_AUTHOR_ALIASES.iter().copied() {
        if sanitized.contains(alias) {
            match best_match {
                Some((prev_alias, _)) if prev_alias.len() >= alias.len() => continue,
                _ => best_match = Some((alias, canonical)),
            }
        }
    }

    if let Some((_, canonical)) = best_match {
        canonical.to_string()
    } else {
        "unknown".to_string()
    }
}

// temporary in-DB lists (later crawler fills)
fn db_characters(conn: &rusqlite::Connection) -> Result<Vec<(i64, String, String)>, String> {
    let mut out = Vec::new();
    let mut stmt = conn
        .prepare("SELECT id, slug, display_name FROM characters")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    while let Some(r) = rows.next().map_err(|e| e.to_string())? {
        out.push((
            r.get(0).unwrap_or(0),
            r.get::<_, String>(1).unwrap_or_default(),
            r.get::<_, String>(2).unwrap_or_default(),
        ));
    }
    Ok(out)
}
fn db_costumes(conn: &rusqlite::Connection) -> Result<Vec<(i64, i64, String, String)>, String> {
    let mut out = Vec::new();
    let mut stmt = conn
        .prepare("SELECT id, character_id, slug, display_name FROM costumes")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    while let Some(r) = rows.next().map_err(|e| e.to_string())? {
        out.push((
            r.get(0).unwrap_or(0),
            r.get(1).unwrap_or(0),
            r.get::<_, String>(2).unwrap_or_default(),
            r.get::<_, String>(3).unwrap_or_default(),
        ));
    }
    Ok(out)
}

fn infer_character_costume(
    folder_name: &str,
    chars: &[(i64, String, String)],
    costumes: &[(i64, i64, String, String)],
) -> (Option<i64>, Option<i64>, f32) {
    let matcher = SkimMatcherV2::default();
    let tokens = norm_tokens(folder_name).join(" ");

    // Try characters
    let mut best_char: Option<(i64, f32)> = None;
    for (id, slug, disp) in chars {
        let score = matcher.fuzzy_match(&tokens, &slug).unwrap_or(0).max(
            matcher
                .fuzzy_match(&tokens, &disp.to_lowercase())
                .unwrap_or(0),
        ) as f32;
        if best_char.map(|(_, s)| score > s).unwrap_or(true) {
            best_char = Some((*id, score));
        }
    }

    // Try costumes constrained by character
    let mut best_cost: Option<(i64, i64, f32)> = None;
    if let Some((cid, cscore)) = best_char {
        for (cost_id, ch_id, slug, disp) in costumes {
            if *ch_id != cid {
                continue;
            }
            let score = matcher.fuzzy_match(&tokens, &slug).unwrap_or(0).max(
                matcher
                    .fuzzy_match(&tokens, &disp.to_lowercase())
                    .unwrap_or(0),
            ) as f32;
            if best_cost.map(|(_, _, s)| score > s).unwrap_or(true) {
                best_cost = Some((*cost_id, *ch_id, score));
            }
        }
        if let Some((cost_id, _ch, cst_score)) = best_cost {
            // confidence: simple scaled version 0..1
            let conf = ((cscore + cst_score) / 200.0).clamp(0.0, 1.0);
            return (Some(cid), Some(cost_id), conf);
        } else {
            let conf = (cscore / 100.0).clamp(0.0, 1.0);
            return (Some(cid), None, conf);
        }
    }
    (None, None, 0.0)
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".into())
}

fn con() -> Result<Connection> {
    let c = db::open_db()?;
    db::migrate(&c)?;
    println!("[db] connection opened");
    Ok(c)
}

fn normalize_path_string(p: &str) -> String {
    match std::fs::canonicalize(p) {
        Ok(abs) => abs.to_string_lossy().to_string(),
        Err(_) => {
            // Fallback: trim trailing separators and normalize separators
            let mut s = p.replace('\\', "/");
            while s.ends_with('/') && s.len() > 1 {
                s.pop();
            }
            s
        }
    }
}

fn tools_dir() -> Result<PathBuf, String> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let app_dir = manifest_dir
        .parent()
        .ok_or_else(|| "Failed to resolve tools directory (app dir missing)".to_string())?;
    let repo_root = app_dir
        .parent()
        .ok_or_else(|| "Failed to resolve tools directory (repo root missing)".to_string())?;
    Ok(repo_root.join("tools"))
}

fn locate_preview_tool() -> Result<PathBuf, String> {
    let dir = tools_dir()?;
    let entries = fs::read_dir(&dir)
        .map_err(|e| format!("Failed to read tools dir '{}': {}", dir.display(), e))?;

    let mut candidates: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().map(|ft| ft.is_file()).unwrap_or(false))
        .map(|entry| entry.path())
        .filter(|path| {
            if let Some(name) = path.file_name().and_then(|f| f.to_str()) {
                name.starts_with("create_preview") && name.ends_with(".jar")
            } else {
                false
            }
        })
        .collect();

    if candidates.is_empty() {
        return Err("No create_preview*.jar found in tools directory".into());
    }

    candidates.sort();
    Ok(candidates
        .into_iter()
        .last()
        .expect("candidates is not empty so last() is Some"))
}

#[derive(Clone, Copy, Debug)]
enum PreviewKind {
    Image,
    Video,
}

impl PreviewKind {
    fn target_name(self) -> &'static str {
        match self {
            PreviewKind::Image => "preview.png",
            PreviewKind::Video => "preview.mp4",
        }
    }

    fn label(self) -> &'static str {
        match self {
            PreviewKind::Image => "image",
            PreviewKind::Video => "video",
        }
    }
}

fn emit_preview_progress(
    window: &Window,
    kind: PreviewKind,
    status: &'static str,
    total: usize,
    processed: usize,
    generated: usize,
    skipped: usize,
    errors: usize,
    current_mod: Option<String>,
    message: Option<String>,
) {
    let payload = PreviewProgressEvent {
        kind: kind.label(),
        status,
        total,
        processed,
        generated,
        skipped,
        errors,
        current_mod,
        message,
    };
    if let Err(err) = window.emit("preview-progress", payload) {
        println!(
            "[preview] failed to emit progress event for {:?}: {}",
            kind, err
        );
    }
}

fn collect_preview_targets(conn: &Connection) -> Result<Vec<PreviewTarget>, String> {
    let mut stmt = conn
        .prepare("SELECT id, display_name, folder_path FROM mods ORDER BY display_name ASC")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        out.push(PreviewTarget {
            id: row.get(0).map_err(|e| e.to_string())?,
            display_name: row.get(1).map_err(|e| e.to_string())?,
            folder_path: row.get(2).map_err(|e| e.to_string())?,
        });
    }
    Ok(out)
}

fn generate_previews(
    window: &Window,
    kind: PreviewKind,
) -> Result<PreviewGenerationSummary, String> {
    let jar = match locate_preview_tool() {
        Ok(jar) => jar,
        Err(err) => {
            emit_preview_progress(
                window,
                kind,
                "error",
                0,
                0,
                0,
                0,
                0,
                None,
                Some(err.clone()),
            );
            return Err(err);
        }
    };

    println!("[preview] using generator jar '{}'", jar.to_string_lossy());

    let conn = con().map_err(|e| e.to_string())?;
    let mods = collect_preview_targets(&conn)?;
    let total = mods.len();

    let mut summary = PreviewGenerationSummary {
        generated: 0,
        skipped: 0,
        errors: 0,
    };

    emit_preview_progress(
        window,
        kind,
        "running",
        total,
        0,
        summary.generated,
        summary.skipped,
        summary.errors,
        None,
        None,
    );

    for (index, target_mod) in mods.iter().enumerate() {
        let folder = Path::new(&target_mod.folder_path);
        let path_display = target_mod.display_name.clone();
        let target = folder.join(kind.target_name());
        if !folder.exists() {
            println!(
                "[preview] skipping mod id={} display='{}' because folder is missing",
                target_mod.id, target_mod.display_name
            );
            summary.errors += 1;
            emit_preview_progress(
                window,
                kind,
                "running",
                total,
                index + 1,
                summary.generated,
                summary.skipped,
                summary.errors,
                Some(path_display),
                Some("Folder missing on disk".to_string()),
            );
            continue;
        }

        if target.exists() {
            summary.skipped += 1;
            emit_preview_progress(
                window,
                kind,
                "running",
                total,
                index + 1,
                summary.generated,
                summary.skipped,
                summary.errors,
                Some(path_display),
                Some("Preview already exists".to_string()),
            );
            continue;
        }

        println!(
            "[preview] generating {:?} for mod id={} display='{}'",
            kind, target_mod.id, target_mod.display_name
        );

        emit_preview_progress(
            window,
            kind,
            "running",
            total,
            index,
            summary.generated,
            summary.skipped,
            summary.errors,
            Some(target_mod.display_name.clone()),
            Some("Starting generator".to_string()),
        );

        let mut cmd = Command::new("java");
        cmd.arg("--enable-native-access=ALL-UNNAMED")
            .arg("-jar")
            .arg(&jar)
            .arg("--folder")
            .arg(&target_mod.folder_path);

        match kind {
            PreviewKind::Image => {
                cmd.arg("--output").arg(target.as_os_str());
            }
            PreviewKind::Video => {
                cmd.arg("--video-seconds")
                    .arg("5")
                    .arg("--fps")
                    .arg("30")
                    .arg("--video-loop")
                    .arg("auto")
                    .arg("--video-output")
                    .arg(target.as_os_str());
            }
        }

        if let Some(parent) = jar.parent() {
            cmd.current_dir(parent);
        }

        let output = match cmd.output() {
            Ok(output) => output,
            Err(err) => {
                let msg = format!("Failed to run java command: {}", err);
                emit_preview_progress(
                    window,
                    kind,
                    "error",
                    total,
                    index,
                    summary.generated,
                    summary.skipped,
                    summary.errors + 1,
                    Some(path_display),
                    Some(msg.clone()),
                );
                return Err(msg);
            }
        };

        if !output.stdout.is_empty() {
            println!(
                "[preview] java stdout id={} display='{}':
{}",
                target_mod.id,
                target_mod.display_name,
                String::from_utf8_lossy(&output.stdout)
            );
        }
        if !output.stderr.is_empty() {
            println!(
                "[preview] java stderr id={} display='{}':
{}",
                target_mod.id,
                target_mod.display_name,
                String::from_utf8_lossy(&output.stderr)
            );
        }

        let mut message = if output.status.success() {
            summary.generated += 1;
            "Preview generated".to_string()
        } else {
            summary.errors += 1;
            let stderr = String::from_utf8_lossy(&output.stderr);
            let short = stderr
                .lines()
                .rev()
                .find(|line| !line.trim().is_empty())
                .map(|line| line.trim().to_string())
                .unwrap_or_else(|| "Preview generation failed".to_string());
            println!(
                "[preview] generator failed for id={} status={} stderr={}",
                target_mod.id, output.status, stderr
            );
            short
        };

        if output.status.success() && !target.exists() {
            summary.generated = summary.generated.saturating_sub(1);
            summary.errors += 1;
            message = "Generator reported success but preview is missing".to_string();
        }

        emit_preview_progress(
            window,
            kind,
            "running",
            total,
            index + 1,
            summary.generated,
            summary.skipped,
            summary.errors,
            Some(target_mod.display_name.clone()),
            Some(message),
        );
    }

    let completion_msg = format!(
        "Completed: generated {} / {} • skipped {} • errors {}",
        summary.generated, total, summary.skipped, summary.errors
    );
    emit_preview_progress(
        window,
        kind,
        "done",
        total,
        total,
        summary.generated,
        summary.skipped,
        summary.errors,
        None,
        Some(completion_msg),
    );

    Ok(summary)
}

fn preview_info_for_path(folder_path: &str) -> PreviewInfo {
    let folder = Path::new(folder_path);
    let image_path = folder.join("preview.png");
    let video_path = folder.join("preview.mp4");
    let has_image = image_path.exists();
    let has_video = video_path.exists();
    let image_path_norm = normalize_path_string(&image_path.to_string_lossy());
    let video_path_norm = normalize_path_string(&video_path.to_string_lossy());

    println!(
        "[preview_info] folder='{}' image='{}' (exists={}) video='{}' (exists={})",
        folder_path, image_path_norm, has_image, video_path_norm, has_video
    );

    PreviewInfo {
        has_image,
        has_video,
        image_path: if has_image {
            Some(image_path_norm)
        } else {
            None
        },
        video_path: if has_video {
            Some(video_path_norm)
        } else {
            None
        },
    }
}

fn mod_exists_by_path(conn: &rusqlite::Connection, fp_norm: &str) -> Result<bool, String> {
    let mut stmt = conn
        .prepare("SELECT 1 FROM mods WHERE folder_path = ?1 LIMIT 1")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query([fp_norm]).map_err(|e| e.to_string())?;
    let exists = rows.next().map_err(|e| e.to_string())?.is_some();
    println!("[db] mod_exists_by_path path='{}' -> {}", fp_norm, exists);
    Ok(exists)
}

#[tauri::command]
pub fn db_init() -> Result<String, String> {
    println!("[db_init] ensuring database ready");
    let conn = con().map_err(|e| e.to_string())?;
    drop(conn);

    match catalog::sync_builtin() {
        Ok(report) => {
            println!(
                "[catalog] builtin sync characters={} costumes={}",
                report.characters, report.costumes
            );
        }
        Err(e) => {
            eprintln!("[catalog] builtin sync failed: {}", e);
            return Err(e);
        }
    }

    Ok("ok".to_string())
}

#[tauri::command]
pub fn mods_add(new_mod: NewMod) -> Result<i64, String> {
    let conn = con().map_err(|e| e.to_string())?;
    let now = now_iso();
    println!(
        "[mods_add] inserting manual mod display_name='{}' folder_path='{}'",
        new_mod.display_name, new_mod.folder_path
    );
    let mut stmt = conn
        .prepare(
            r#"
        INSERT INTO mods (
          character_id, costume_id, author, download_url, installed, installed_at,
          target_path, mod_type, folder_path, display_name, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, 0, NULL, NULL, ?5, ?6, ?7, ?8, ?8)
        "#,
        )
        .map_err(|e| e.to_string())?;

    let mod_type_str = new_mod.mod_type.to_string();

    stmt.execute(params![
        new_mod.character_id,
        new_mod.costume_id,
        new_mod.author,
        new_mod.download_url,
        mod_type_str,
        new_mod.folder_path,
        new_mod.display_name,
        now
    ])
    .map_err(|e| e.to_string())?;

    Ok(conn.last_insert_rowid())
}

/* ===========Commands=========== */

#[tauri::command]
pub fn previews_generate_images(window: Window) -> Result<PreviewGenerationSummary, String> {
    generate_previews(&window, PreviewKind::Image)
}

#[tauri::command]
pub fn previews_generate_videos(window: Window) -> Result<PreviewGenerationSummary, String> {
    generate_previews(&window, PreviewKind::Video)
}

#[tauri::command]
pub fn mod_preview_info(id: i64) -> Result<PreviewInfo, String> {
    let conn = con().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT folder_path FROM mods WHERE id = ?1")
        .map_err(|e| e.to_string())?;
    let folder_path = stmt
        .query_row([id], |r| r.get::<_, String>(0))
        .optional()
        .map_err(|e| e.to_string())?;

    match folder_path {
        Some(path) => Ok(preview_info_for_path(&path)),
        None => Err(format!("Mod with id={} not found", id)),
    }
}

#[tauri::command]
pub fn mods_list(filter: Option<ModFilter>) -> Result<Vec<ModRow>, String> {
    use rusqlite::{params, Rows};

    println!(
        "[mods_list] listing mods with filter={}",
        filter.as_ref().map(|_| "some").unwrap_or("none")
    );
    let conn = con().map_err(|e| e.to_string())?;

    // Normalize filter inputs; everything optional is allowed to be NULL.
    let (cid, coid, author_like, q_like) = if let Some(f) = filter {
        let author_like = f.author.map(|s| format!("%{}%", s));
        let q_like = f.q.map(|s| format!("%{}%", s));
        (f.character_id, f.costume_id, author_like, q_like)
    } else {
        (None, None, None, None)
    };

    // Use positional parameters ?1 ?2 ?3 ?4
    let sql = r#"
        SELECT id, display_name, folder_path, author, download_url,
               character_id, costume_id, mod_type, installed, installed_at,
               target_path, created_at, updated_at
        FROM mods
        WHERE (?1 IS NULL OR character_id = ?1)
          AND (?2 IS NULL OR costume_id  = ?2)
          AND (?3 IS NULL OR author LIKE ?3)
          AND (?4 IS NULL OR display_name LIKE ?4 OR folder_path LIKE ?4)
        ORDER BY updated_at DESC
    "#;

    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let mut rows: Rows = stmt
        .query(params![cid, coid, author_like, q_like])
        .map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    while let Some(r) = rows.next().map_err(|e| e.to_string())? {
        let mod_type_s: String = r.get(7).map_err(|e| e.to_string())?;
        let mt = ModType::from_str(mod_type_s.as_str());
        out.push(ModRow {
            id: r.get(0).map_err(|e| e.to_string())?,
            display_name: r.get(1).map_err(|e| e.to_string())?,
            folder_path: r.get(2).map_err(|e| e.to_string())?,
            author: r.get(3).map_err(|e| e.to_string())?,
            download_url: r.get(4).map_err(|e| e.to_string())?,
            character_id: r.get(5).map_err(|e| e.to_string())?,
            costume_id: r.get(6).map_err(|e| e.to_string())?,
            mod_type: mt,
            installed: r.get::<_, i64>(8).map_err(|e| e.to_string())? != 0,
            installed_at: r.get(9).map_err(|e| e.to_string())?,
            target_path: r.get(10).map_err(|e| e.to_string())?,
            created_at: r.get(11).map_err(|e| e.to_string())?,
            updated_at: r.get(12).map_err(|e| e.to_string())?,
        });
    }

    Ok(out)
}

#[tauri::command]
pub fn mods_set_installed(
    id: i64,
    installed: bool,
    target_path: Option<String>,
) -> Result<(), String> {
    use rusqlite::params;
    println!(
        "[mods_set_installed] id={} installed={} target_path={:?}",
        id, installed, target_path
    );
    let conn = con().map_err(|e| e.to_string())?;
    let now = now_iso();

    let installed_int = if installed { 1 } else { 0 };
    let installed_at = if installed { Some(now.clone()) } else { None }; // <-- clone here

    let n = conn
        .execute(
            r#"
            UPDATE mods
            SET installed = ?2,
                installed_at = ?3,
                target_path = CASE WHEN ?2 = 1 THEN ?4 ELSE NULL END,
                updated_at = ?5
            WHERE id = ?1
            "#,
            params![id, installed_int, installed_at, target_path, now],
        )
        .map_err(|e| e.to_string())?;

    if n == 0 {
        return Err("Mod not found".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn settings_get() -> Result<AppSettings, String> {
    println!("[settings_get] loading settings");
    let conn = con().map_err(|e| e.to_string())?;
    let val: Option<String> = conn
        .query_row(
            "SELECT value_json FROM settings WHERE key='app_settings'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    let settings: AppSettings = val
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default();
    println!(
        "[settings_get] loaded library_dirs={} game_mods_dir={:?} last_library_pick={:?}",
        settings.library_dirs.len(),
        settings.game_mods_dir,
        settings.last_library_pick
    );
    Ok(settings)
}

#[tauri::command]
pub fn settings_set(new_settings: AppSettings) -> Result<AppSettings, String> {
    println!(
        "[settings_set] saving settings library_dirs={} game_mods_dir={:?} last_library_pick={:?}",
        new_settings.library_dirs.len(),
        new_settings.game_mods_dir,
        new_settings.last_library_pick
    );
    let conn = con().map_err(|e| e.to_string())?;
    let json = serde_json::to_string(&new_settings).map_err(|e| e.to_string())?;
    conn.execute(
        r#"
        INSERT INTO settings(key, value_json)
        VALUES ('app_settings', ?1)
        ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json
        "#,
        rusqlite::params![json],
    )
    .map_err(|e| e.to_string())?;
    Ok(new_settings)
}

#[tauri::command]
pub fn library_author_dirs(lib_root: String) -> Result<Vec<AuthorFolder>, String> {
    use walkdir::WalkDir;
    println!("[library_author_dirs] root='{}'", lib_root);
    let mut out = Vec::new();
    for entry in WalkDir::new(&lib_root).min_depth(1).max_depth(1) {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                println!(
                    "[library_author_dirs] failed to access entry under '{}' err={}",
                    lib_root, e
                );
                continue;
            }
        };
        if !entry.file_type().is_dir() {
            continue;
        }
        let folder_path = normalize_path_string(&entry.path().to_string_lossy());
        let folder_name = entry.file_name().to_string_lossy().to_string();
        let inferred = infer_author_name(&folder_name);
        out.push(AuthorFolder {
            folder_path,
            inferred_author: inferred,
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn paths_rescan() -> Result<ScanSummary, String> {
    use walkdir::WalkDir;
    println!("[paths_rescan] started");
    let conn = con().map_err(|e| e.to_string())?;
    let settings = settings_get()?;

    let mut scanned_dirs = 0usize;
    let mut discovered_mods = 0usize;
    let mut upserts = 0usize;
    let mut errors = 0usize;
    let now = now_iso();

    for lib_root in settings.library_dirs.iter() {
        scanned_dirs += 1;

        println!("[paths_rescan] scanning library root='{}'", lib_root);
        // Expect structure: lib_root/AuthorName/ModFolder
        for author_entry in WalkDir::new(lib_root).min_depth(1).max_depth(1) {
            let author_entry = match author_entry {
                Ok(e) => e,
                Err(_) => {
                    errors += 1;
                    continue;
                }
            };
            if !author_entry.file_type().is_dir() {
                continue;
            }
            let author_folder = author_entry.file_name().to_string_lossy().to_string();
            let author = infer_author_name(&author_folder);

            // Iterate mod folders inside this author folder
            for mod_entry in WalkDir::new(author_entry.path()).min_depth(1).max_depth(1) {
                let mod_entry = match mod_entry {
                    Ok(e) => e,
                    Err(_) => {
                        errors += 1;
                        continue;
                    }
                };
                if !mod_entry.file_type().is_dir() {
                    continue;
                }
                let display_name = mod_entry.file_name().to_string_lossy().to_string();
                let folder_path = normalize_path_string(&mod_entry.path().to_string_lossy());
                println!(
                    "[paths_rescan] discovered author_folder='{}' author='{}' display='{}' folder='{}'",
                    author_folder, author, display_name, folder_path
                );
                discovered_mods += 1;

                // Upsert (author + names)
                let n = conn
                    .execute(
                        r#"
                    INSERT INTO mods (
                      character_id, costume_id, author, download_url, installed, installed_at,
                      target_path, mod_type, folder_path, display_name, created_at, updated_at
                    ) VALUES (NULL, NULL, ?1, NULL, 0, NULL, NULL, 'other', ?2, ?3, ?4, ?4)
                    ON CONFLICT(folder_path) DO UPDATE SET
                      display_name=excluded.display_name,
                      author=excluded.author,
                      updated_at=excluded.updated_at
                    "#,
                        rusqlite::params![author, folder_path, display_name, now],
                    )
                    .map_err(|e| e.to_string())?;
                if n > 0 {
                    upserts += 1;
                }
            }
        }
    }

    Ok(ScanSummary {
        scanned_dirs,
        discovered_mods,
        upserts,
        errors,
    })
}

#[tauri::command]
pub fn mods_import_dry_run(
    author_dir: String,
    default_author: Option<String>,
    default_download_url: Option<String>,
    _default_mod_type: Option<String>,
) -> Result<Vec<DraftMod>, String> {
    use walkdir::WalkDir;
    println!(
        "[mods_import_dry_run] dir='{}' default_author={:?}",
        author_dir, default_author
    );
    let conn = con().map_err(|e| e.to_string())?;
    let chars = db_characters(&conn)?;
    let costumes = db_costumes(&conn)?;

    let inferred_author = std::path::Path::new(&author_dir)
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| infer_author_name(s));

    let author = default_author
        .and_then(|raw| {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        })
        .or(inferred_author)
        .map(|name| {
            if name.trim().is_empty() {
                "unknown".to_string()
            } else {
                name
            }
        });

    let mut out = Vec::new();
    for entry in WalkDir::new(&author_dir).min_depth(1).max_depth(1) {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !entry.file_type().is_dir() {
            continue;
        }
        let display_name = entry.file_name().to_string_lossy().to_string();
        let folder_path = normalize_path_string(&entry.path().to_string_lossy());

        let (character_id, costume_id, conf) =
            infer_character_costume(&display_name, &chars, &costumes);

        let mt = infer_mod_type(&display_name);

        out.push(DraftMod {
            display_name,
            folder_path,
            author: author.clone(),
            download_url: default_download_url.clone(),
            mod_type: mt,
            character_id,
            costume_id,
            infer_confidence: conf,
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn mods_import_commit(drafts: Vec<DraftMod>) -> Result<(usize, usize), String> {
    use rusqlite::params;
    use std::collections::HashSet;

    println!("[mods_import_commit] committing {} drafts", drafts.len());
    let mut conn = con().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let now = now_iso();

    let mut inserted = 0usize;
    let mut updated = 0usize;

    // De-dupe in the backend too (belt & suspenders)
    let mut seen = HashSet::<String>::new();

    for d in drafts {
        let fp_norm = normalize_path_string(&d.folder_path);
        if !seen.insert(fp_norm.clone()) {
            // duplicate in same batch → skip
            println!(
                "[mods_import_commit] duplicate draft skipped for folder_path='{}'",
                fp_norm
            );
            continue;
        }

        let existed = mod_exists_by_path(&tx, &fp_norm)?;
        println!(
            "[mods_import_commit] processing display='{}' path='{}' existed_in_db={}",
            d.display_name, fp_norm, existed
        );

        tx.execute(
            r#"
            INSERT INTO mods (
              character_id, costume_id, author, download_url, installed, installed_at,
              target_path, mod_type, folder_path, display_name, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, 0, NULL, NULL, ?5, ?6, ?7, ?8, ?8)
            ON CONFLICT(folder_path) DO UPDATE SET
              display_name = excluded.display_name,
              author = excluded.author,
              download_url = excluded.download_url,
              character_id = excluded.character_id,
              costume_id = excluded.costume_id,
              mod_type = excluded.mod_type,
              updated_at = excluded.updated_at
            "#,
            params![
                d.character_id,
                d.costume_id,
                d.author,
                d.download_url,
                d.mod_type.to_string(),
                fp_norm,
                d.display_name,
                now
            ],
        )
        .map_err(|e| {
            println!(
                "[mods_import_commit] upsert FAILED path='{}' err={}",
                fp_norm, e
            );
            e.to_string()
        })?;

        println!(
            "[mods_import_commit] upsert success path='{}' action={}",
            fp_norm,
            if existed { "updated" } else { "inserted" }
        );

        if existed {
            updated += 1;
        } else {
            inserted += 1;
        }
    }

    tx.commit().map_err(|e| {
        println!("[mods_import_commit] commit FAILED err={}", e);
        e.to_string()
    })?;
    println!(
        "[mods_import_commit] done inserted={} updated={}",
        inserted, updated
    );
    Ok((inserted, updated))
}

#[derive(Serialize)]
pub struct CatalogCharacterRow {
    pub id: i64,
    pub slug: String,
    pub display_name: String,
}

#[derive(Serialize)]
pub struct CatalogCostumeRow {
    pub id: i64,
    pub character_id: i64,
    pub slug: String,
    pub display_name: String,
}

#[derive(Serialize)]
pub struct CatalogListResponse {
    pub characters: Vec<CatalogCharacterRow>,
    pub costumes: Vec<CatalogCostumeRow>,
}

#[tauri::command]
pub fn catalog_import_from_file(path: String) -> Result<CatalogReport, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("path is empty".to_string());
    }
    let path = Path::new(trimmed);
    println!("[catalog] importing from {}", path.display());
    catalog::sync_from_path(path)
}

#[tauri::command]
pub fn catalog_list() -> Result<CatalogListResponse, String> {
    let conn = con().map_err(|e| e.to_string())?;
    let chars = db_characters(&conn)?;
    let costumes = db_costumes(&conn)?;

    Ok(CatalogListResponse {
        characters: chars
            .into_iter()
            .map(|(id, slug, display_name)| CatalogCharacterRow {
                id,
                slug,
                display_name,
            })
            .collect(),
        costumes: costumes
            .into_iter()
            .map(|(id, character_id, slug, display_name)| CatalogCostumeRow {
                id,
                character_id,
                slug,
                display_name,
            })
            .collect(),
    })
}

#[tauri::command]
pub fn mods_purge_all() -> Result<usize, String> {
    let conn = con().map_err(|e| e.to_string())?;
    let affected = conn
        .execute("DELETE FROM mods", [])
        .map_err(|e| e.to_string())?;
    println!("[mods_purge_all] deleted {} mods", affected);
    Ok(affected as usize)
}
