import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import ImportWizard from "@/components/ImportWizard";

type ModType = "idle" | "cutscene" | "date" | "battle" | "ui" | "other";
type NewMod = {
  display_name: string;
  folder_path: string;
  author?: string;
  download_url?: string;
  character_id?: number;
  costume_id?: number;
  mod_type: ModType;
};
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
};
type ScanSummary = {
  scanned_dirs: number;
  discovered_mods: number;
  upserts: number;
  errors: number;
};

type UiCrawlerSource = {
  kind: "json" | "html";
  url: string;
  cfg_json?: any;
  enabled: boolean;
};

export default function App() {
  const [version, setVersion] = useState<string>("");
  const [mods, setMods] = useState<ModRow[]>([]);
  const [settings, setSettings] = useState<AppSettings>({
    library_dirs: [],
    game_mods_dir: null,
    install_strategy: "copy",
  });
  const [busy, setBusy] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  useEffect(() => {
    invoke<string>("app_version")
      .then(setVersion)
      .catch(() => setVersion("dev"));
    invoke<string>("db_init");
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
    setSettings(s);
  }

  async function saveSettings(next: AppSettings) {
    const s = await invoke<AppSettings>("settings_set", { newSettings: next });
    setSettings(s);
  }

  async function addLibDir() {
    const picked = await open({ directory: true, multiple: false });
    if (!picked || typeof picked !== "string") return;
    const next = {
      ...settings,
      library_dirs: Array.from(
        new Set([...(settings.library_dirs || []), picked]),
      ),
    };
    await saveSettings(next);
  }

  async function removeLibDir(idx: number) {
    const next = {
      ...settings,
      library_dirs: (settings.library_dirs || []).filter((_, i) => i !== idx),
    };
    await saveSettings(next);
  }

  async function pickGameDir() {
    const picked = await open({ directory: true, multiple: false });
    if (!picked || typeof picked !== "string") return;
    const next = { ...settings, game_mods_dir: picked };
    await saveSettings(next);
  }

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

  async function addDummy() {
    const m: NewMod = {
      display_name: "Sample Mod A",
      folder_path: "/path/to/modA",
      author: "You",
      download_url: "https://example.com/modA",
      mod_type: "idle",
    };
    await invoke<number>("mods_add", { newMod: m });
    refresh();
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

  // state
  const [sources, setSources] = useState<UiCrawlerSource[]>([]);

  useEffect(() => {
    (async () => {
      const raw = await invoke<any[]>("crawler_get_sources").catch(() => []);
      const mapped: UiCrawlerSource[] = (raw ?? []).map((s) => ({
        kind: s?.kind === "html" ? "html" : "json",
        url: String(s?.url ?? ""),
        cfg_json: s?.cfg_json,
        enabled: Boolean(s?.enabled),
      }));
      setSources(mapped);
    })();
  }, []);

  // helpers
  async function saveSources(next: UiCrawlerSource[]) {
    await invoke("crawler_set_sources", { sources: next });
    setSources(next);
  }

  async function addJsonSource() {
    const url =
      prompt(
        "JSON URL (can be file://...):",
        "file:///home/you/characters.json",
      ) || "";
    if (!url) return;
    await saveSources([...sources, { kind: "json", url, enabled: true }]);
  }
  async function runCrawler() {
    const res = await invoke<{
      sources: number;
      characters: number;
      costumes: number;
    }>("crawler_run_now");
    alert(`Crawler: ${res.characters} characters, ${res.costumes} costumes`);
  }

  return (
    <div className="h-screen w-screen text-zinc-100">
      {/* Top bar */}
      <div className="h-12 border-b border-zinc-800 px-4 flex items-center justify-between bg-zinc-950/60 backdrop-blur">
        <div className="font-medium">Mod Manager (Tauri)</div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" onClick={addDummy}>
            Add Dummy
          </Button>
          <Button size="sm" onClick={() => setImportOpen(true)}>
            Import Mods
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
        {/* Left: Settings + List */}
        <div className="h-full p-3 space-y-3">
          <Card>
            <CardHeader>
              <CardTitle>Settings</CardTitle>
            </CardHeader>
            <Separator />
            <CardContent className="space-y-3">
              <div>
                <div className="text-xs opacity-70 mb-1">Library folders</div>
                <div className="space-y-2">
                  {(settings.library_dirs || []).map((d, i) => (
                    <div key={d} className="flex items-center gap-2">
                      <Input readOnly value={d} />
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => removeLibDir(i)}
                      >
                        Remove
                      </Button>
                    </div>
                  ))}
                  <Button size="sm" onClick={addLibDir}>
                    Add Library Folder
                  </Button>
                </div>
              </div>

              <div className="mt-4">
                <div className="text-xs opacity-70 mb-1">Crawler sources</div>
                <div className="space-y-2">
                  {sources.map((s, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <Input readOnly value={`${s.kind} | ${s.url}`} />
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={async () => {
                          const next = sources.slice();
                          next.splice(i, 1);
                          await saveSources(next);
                        }}
                      >
                        Remove
                      </Button>
                    </div>
                  ))}
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={addJsonSource}
                    >
                      Add JSON Source
                    </Button>
                    <Button size="sm" onClick={runCrawler}>
                      Run Crawler
                    </Button>
                  </div>
                </div>
              </div>

              <div>
                <div className="text-xs opacity-70 mb-1">Game mods folder</div>
                <div className="flex items-center gap-2">
                  <Input
                    readOnly
                    value={settings.game_mods_dir || ""}
                    placeholder="Not set"
                  />
                  <Button size="sm" onClick={pickGameDir}>
                    Pick
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="h-[calc(100%-16rem)] overflow-hidden">
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
    </div>
  );
}
