use anyhow::{Context, Result};
use directories::ProjectDirs;
use rusqlite::Connection;
use std::fs;
use std::path::PathBuf;

pub fn db_path() -> Result<PathBuf> {
    // Change org/app names to your identifiers
    let proj = ProjectDirs::from("org", "BrownDust2", "ModsHandler")
        .context("Cannot resolve platform data dir")?;
    let data_dir = proj.data_dir();
    fs::create_dir_all(data_dir).context("Failed to create app data dir")?;
    Ok(data_dir.join("mods.db"))
}

pub fn open_db() -> Result<Connection> {
    let path = db_path()?;
    let conn = Connection::open(path).context("Failed to open sqlite")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(conn)
}

pub fn migrate(conn: &Connection) -> Result<()> {
    // Simple versioned migrations
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS _schema_version (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          version INTEGER NOT NULL
        );
        INSERT INTO _schema_version(id, version)
          SELECT 1, 0 WHERE NOT EXISTS (SELECT 1 FROM _schema_version WHERE id=1);
        "#,
    )?;

    let current: i64 =
        conn.query_row("SELECT version FROM _schema_version WHERE id=1;", [], |r| {
            r.get(0)
        })?;

    if current < 1 {
        // v1 schema
        conn.execute_batch(
            r#"
            -- canonical lists (crawler-owned)
            CREATE TABLE characters (
              id INTEGER PRIMARY KEY,
              slug TEXT UNIQUE NOT NULL,
              display_name TEXT NOT NULL
            );
            CREATE TABLE costumes (
              id INTEGER PRIMARY KEY,
              character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
              slug TEXT NOT NULL,
              display_name TEXT NOT NULL,
              UNIQUE(character_id, slug)
            );

            -- mods
            CREATE TABLE mods (
              id INTEGER PRIMARY KEY,
              character_id INTEGER REFERENCES characters(id) ON DELETE SET NULL,
              costume_id INTEGER REFERENCES costumes(id) ON DELETE SET NULL,
              author TEXT,
              download_url TEXT,
              installed INTEGER NOT NULL DEFAULT 0,           -- 0/1
              installed_at TEXT,                              -- ISO8601
              target_path TEXT,                               -- where in the game dir (optional for now)
              mod_type TEXT NOT NULL DEFAULT 'idle'
                CHECK (mod_type IN ('idle','cutscene','date','battle','ui','other')),
              folder_path TEXT NOT NULL,                      -- absolute or chosen base + relative
              display_name TEXT NOT NULL,                     -- friendly name (usually folder name)
              created_at TEXT NOT NULL,                       -- ISO8601
              updated_at TEXT NOT NULL                        -- ISO8601
            );

            CREATE INDEX mods_character_costume_idx ON mods(character_id, costume_id);
            CREATE INDEX mods_author_idx ON mods(author);
            "#,
        )?;
        conn.execute("UPDATE _schema_version SET version=1 WHERE id=1;", [])?;
    }

    if current < 2 {
        conn.execute_batch(
            r#"
                -- ensure each mod folder path is unique
                CREATE UNIQUE INDEX IF NOT EXISTS mods_folder_path_unique ON mods(folder_path);
                "#,
        )?;
        conn.execute("UPDATE _schema_version SET version=2 WHERE id=1;", [])?;
    }

    Ok(())
}
