import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import ImportWizard from "@/components/ImportWizard";
import SettingsDialog from "@/components/SettingsDialog";

type ModType =
  | "idle"
  | "cutscene"
  | "history"
  | "date"
  | "minigame"
  | "swap"
  | "battle"
  | "ui"
  | "other";
type ModRow = {
  id: number;
  display_name: string;
  folder_path: string;
  author?: string;
  download_url?: string;
  character_id?: number;
  costume_id?: number;
  mod_type: ModType;
  installed: boolean;
  installed_at?: string;
  target_path?: string;
  created_at: string;
  updated_at: string;
};
type AppSettings = {
  library_dirs: string[];
  game_mods_dir?: string | null;
  install_strategy?: string | null;
  last_library_pick?: string | null;
};
type ScanSummary = {
  scanned_dirs: number;
  discovered_mods: number;
  upserts: number;
  errors: number;
};
type CatalogReport = {
  characters: number;
  costumes: number;
};

export default function App() {
  const [version, setVersion] = useState<string>("");
  const [mods, setMods] = useState<ModRow[]>([]);
  const [settings, setSettings] = useState<AppSettings>({
    library_dirs: [],
    game_mods_dir: null,
    install_strategy: "copy",
    last_library_pick: null,
  });
  const [busy, setBusy] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    invoke<string>("app_version")
      .then(setVersion)
      .catch(() => setVersion("dev"));
    invoke<string>("db_init").catch(console.error);
    loadSettings();
    refresh();
  }, []);

  function refresh() {
    invoke<ModRow[]>("mods_list", { filter: null })
      .then(setMods)
      .catch(console.error);
  }

  async function loadSettings() {
    const s = await invoke<AppSettings>("settings_get");
    console.log("[settings] loaded settings", s);
    setSettings(s);
  }

  async function saveSettings(next: AppSettings) {
    console.log("[settings] saving settings payload", next);
    setSettings(next);
    try {
      const s = await invoke<AppSettings>("settings_set", {
        newSettings: next,
      });
      console.log("[settings] backend confirmed settings", s);
      setSettings(s);
    } catch (err) {
      console.error("[settings] failed to persist settings", err);
    }
  }

  async function addLibDir() {
    console.log("[settings] add library folder triggered");
    const picked = await open({ directory: true, multiple: false });
    if (!picked || typeof picked !== "string") {
      console.log("[settings] add library folder cancelled");
      return;
    }
    console.log("[settings] selected library folder", picked);
    const next = {
      ...settings,
      last_library_pick: picked,
      library_dirs: Array.from(
        new Set([...(settings.library_dirs || []), picked]),
      ),
    };
    console.log("[settings] computed next settings", next);
    await saveSettings(next);
    console.log("[settings] library directories", next.library_dirs);
    await loadSettings();
  }

  async function pickGameDir() {
    const picked = await open({ directory: true, multiple: false });
    if (!picked || typeof picked !== "string") return;
    const next = { ...settings, game_mods_dir: picked };
    await saveSettings(next);
  }

  useEffect(() => {
    console.log("[settings] state applied", settings);
  }, [settings]);

  async function rescan() {
    setBusy(true);
    try {
      const summary = await invoke<ScanSummary>("paths_rescan");
      console.log("rescan summary", summary);
      refresh();
    } finally {
      setBusy(false);
    }
  }

  async function toggleInstall(mod: ModRow) {
    await invoke("mods_set_installed", {
      id: mod.id,
      installed: !mod.installed,
      targetPath: !mod.installed
        ? settings.game_mods_dir
          ? `${settings.game_mods_dir}/${mod.display_name}`
          : null
        : null,
    });
    refresh();
  }

  async function importCatalog() {
    const picked = await open({
      multiple: false,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!picked || typeof picked !== "string") return;
    try {
      const report = await invoke<CatalogReport>("catalog_import_from_file", {
        path: picked,
      });
      alert(
        `Catalog updated: ${report.characters} characters, ${report.costumes} costumes`,
      );
    } catch (e) {
      console.error(e);
      alert(String(e));
    }
  }

  return (
    <div className="h-screen w-screen text-zinc-100">
      {/* Top bar */}
      <div className="h-12 border-b border-zinc-800 px-4 flex items-center justify-between bg-zinc-950/60 backdrop-blur">
        <div className="font-medium">Mod Manager (Tauri)</div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => setImportOpen(true)}>
            Import Mods
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setSettingsOpen(true)}
          >
            Settings
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={rescan}
            disabled={busy}
          >
            {busy ? "Rescanning..." : "Rescan"}
          </Button>
          <div className="text-xs opacity-60">v{version || "—"}</div>
        </div>
      </div>

      {/* Body grid */}
      <div className="h-[calc(100vh-3rem)] grid grid-cols-[35%_65%]">
        {/* Left: List */}
        <div className="h-full p-3">
          <Card className="h-full overflow-hidden">
            <CardHeader>
              <CardTitle>All Mods</CardTitle>
            </CardHeader>
            <Separator />
            <CardContent className="h-[calc(100%-4rem)] overflow-auto">
              <ul className="space-y-2 text-sm">
                {mods.map((m) => (
                  <li
                    key={m.id}
                    className="flex items-center justify-between border-b border-zinc-800 py-2"
                  >
                    <div className="min-w-0">
                      <div className="font-medium truncate">
                        {m.display_name}
                      </div>
                      <div className="text-xs opacity-60 truncate">
                        {m.folder_path}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant={m.installed ? "secondary" : "default"}
                      onClick={() => toggleInstall(m)}
                    >
                      {m.installed ? "Uninstall" : "Install"}
                    </Button>
                  </li>
                ))}
                {mods.length === 0 && (
                  <li className="opacity-60">
                    No mods yet — add a library folder and hit Rescan.
                  </li>
                )}
              </ul>
            </CardContent>
          </Card>
        </div>

        {/* Right: Preview placeholder */}
        <div className="h-full p-3">
          <Card className="h-full">
            <CardHeader>
              <CardTitle>Preview</CardTitle>
            </CardHeader>
            <Separator />
            <CardContent className="h-[calc(100%-4rem)] grid place-items-center">
              <div className="text-sm opacity-60">Select a mod</div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Render the dialog OUTSIDE the grid so it doesn't become a grid item */}
      <ImportWizard
        open={importOpen}
        onOpenChange={setImportOpen}
        onCommitted={refresh}
      />
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={settings}
        onAddLibraryDir={addLibDir}
        onPickGameDir={pickGameDir}
        onImportCatalog={importCatalog}
      />
    </div>
  );
}
