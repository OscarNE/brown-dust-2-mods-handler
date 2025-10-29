use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModType {
    Idle,
    Cutscene,
    Date,
    Battle,
    Ui,
    Other,
}

impl ToString for ModType {
    fn to_string(&self) -> String {
        match self {
            ModType::Idle => "idle",
            ModType::Cutscene => "cutscene",
            ModType::Date => "date",
            ModType::Battle => "battle",
            ModType::Ui => "ui",
            ModType::Other => "other",
        }
        .to_string()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewMod {
    pub display_name: String,
    pub folder_path: String,
    pub author: Option<String>,
    pub download_url: Option<String>,
    pub character_id: Option<i64>,
    pub costume_id: Option<i64>,
    pub mod_type: ModType,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModRow {
    pub id: i64,
    pub display_name: String,
    pub folder_path: String,
    pub author: Option<String>,
    pub download_url: Option<String>,
    pub character_id: Option<i64>,
    pub costume_id: Option<i64>,
    pub mod_type: ModType,
    pub installed: bool,
    pub installed_at: Option<String>,
    pub target_path: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModFilter {
    pub character_id: Option<i64>,
    pub costume_id: Option<i64>,
    pub author: Option<String>,
    pub q: Option<String>, // free text
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    pub library_dirs: Vec<String>,
    pub game_mods_dir: Option<String>,
    pub install_strategy: Option<String>, // "copy" | "symlink" (later)
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            library_dirs: vec![],
            game_mods_dir: None,
            install_strategy: Some("copy".into()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanSummary {
    pub scanned_dirs: usize,
    pub discovered_mods: usize,
    pub upserts: usize,
    pub errors: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DraftMod {
    pub display_name: String,
    pub folder_path: String,
    pub author: Option<String>,
    pub download_url: Option<String>,
    pub mod_type: ModType,
    pub character_id: Option<i64>,
    pub costume_id: Option<i64>,
    pub infer_confidence: f32,
}

// Database helpers for catalog data
use rusqlite::{params, Error, Transaction};

/// Inserts or updates a character by slug, returns the character’s id.
pub fn upsert_character(
    tx: &Transaction<'_>,
    slug: &str,
    display_name: &str,
) -> Result<i64, Error> {
    tx.execute(
        r#"
        INSERT INTO characters (slug, display_name)
        VALUES (?1, ?2)
        ON CONFLICT(slug) DO UPDATE SET display_name = excluded.display_name
        "#,
        params![slug, display_name],
    )?;
    tx.query_row(
        "SELECT id FROM characters WHERE slug = ?1",
        params![slug],
        |r| r.get(0),
    )
}

/// Inserts or updates a costume for a given character id, returns the costume’s id.
pub fn upsert_costume(
    tx: &Transaction<'_>,
    character_id: i64,
    slug: &str,
    display_name: &str,
) -> Result<i64, Error> {
    tx.execute(
        r#"
        INSERT INTO costumes (character_id, slug, display_name)
        VALUES (?1, ?2, ?3)
        ON CONFLICT(character_id, slug) DO UPDATE SET display_name = excluded.display_name
        "#,
        params![character_id, slug, display_name],
    )?;
    tx.query_row(
        "SELECT id FROM costumes WHERE character_id = ?1 AND slug = ?2",
        params![character_id, slug],
        |r| r.get(0),
    )
}

/// Inserts an alias for a character or costume entity. `entity_type` should be "character" or "costume".
pub fn upsert_alias(
    tx: &Transaction<'_>,
    entity_type: &str,
    entity_id: i64,
    alias: &str,
) -> Result<(), Error> {
    if alias.trim().is_empty() {
        return Ok(());
    }
    tx.execute(
        r#"
        INSERT OR IGNORE INTO aliases (entity_type, entity_id, alias_text)
        VALUES (?1, ?2, ?3)
        "#,
        params![entity_type, entity_id, alias],
    )?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogCostume {
    pub slug: String,
    pub display_name: String,
    #[serde(default)]
    pub aliases: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogCharacter {
    pub slug: String,
    pub display_name: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub costumes: Vec<CatalogCostume>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogReport {
    pub characters: usize,
    pub costumes: usize,
}
