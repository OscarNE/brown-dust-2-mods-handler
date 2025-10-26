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
