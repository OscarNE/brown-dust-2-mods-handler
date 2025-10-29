use crate::db;
use crate::types::{CatalogCharacter, CatalogReport};
use std::path::Path;

pub type SResult<T> = Result<T, String>;

#[derive(Debug, serde::Deserialize)]
struct CatalogWrapper {
    characters: Vec<CatalogCharacter>,
}

fn load_from_str(data: &str) -> SResult<Vec<CatalogCharacter>> {
    let trimmed = data.trim();
    if trimmed.starts_with('[') {
        let parsed: Vec<CatalogCharacter> =
            serde_json::from_str(trimmed).map_err(|e| e.to_string())?;
        Ok(parsed)
    } else {
        let wrapper: CatalogWrapper = serde_json::from_str(trimmed).map_err(|e| e.to_string())?;
        Ok(wrapper.characters)
    }
}

fn load_from_path(path: &Path) -> SResult<Vec<CatalogCharacter>> {
    let raw = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    load_from_str(&raw)
}

fn load_builtin() -> SResult<Vec<CatalogCharacter>> {
    let raw = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/data/catalog.json"));
    load_from_str(raw)
}

pub fn sync_from_path(path: &Path) -> SResult<CatalogReport> {
    let items = load_from_path(path)?;
    sync_records(items)
}

pub fn sync_builtin() -> SResult<CatalogReport> {
    let items = load_builtin()?;
    sync_records(items)
}

fn sync_records(items: Vec<CatalogCharacter>) -> SResult<CatalogReport> {
    let mut conn = db::open_db().map_err(|e| e.to_string())?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let mut chars_count = 0usize;
    let mut costs_count = 0usize;

    for ch in items {
        let ch_id = crate::types::upsert_character(&tx, &ch.slug, &ch.display_name)
            .map_err(|e| e.to_string())?;
        chars_count += 1;
        for alias in ch.aliases.iter() {
            crate::types::upsert_alias(&tx, "character", ch_id, alias)
                .map_err(|e| e.to_string())?;
        }
        for costume in ch.costumes {
            let co_id =
                crate::types::upsert_costume(&tx, ch_id, &costume.slug, &costume.display_name)
                    .map_err(|e| e.to_string())?;
            costs_count += 1;
            for alias in costume.aliases.iter() {
                crate::types::upsert_alias(&tx, "costume", co_id, alias)
                    .map_err(|e| e.to_string())?;
            }
        }
    }

    tx.commit().map_err(|e| e.to_string())?;

    Ok(CatalogReport {
        characters: chars_count,
        costumes: costs_count,
    })
}
