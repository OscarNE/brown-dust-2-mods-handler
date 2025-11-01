import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
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
type AuthorFolder = {
  folder_path: string;
  inferred_author: string;
};
type PreviewInfo = {
  has_image: boolean;
  has_video: boolean;
  image_path?: string | null;
  video_path?: string | null;
};
type PreviewGenerationSummary = {
  generated: number;
  skipped: number;
  errors: number;
};
type PreviewProgressPayload = {
  kind: "image" | "video";
  status: "running" | "done" | "error";
  total: number;
  processed: number;
  generated: number;
  skipped: number;
  errors: number;
  current_mod?: string | null;
  message?: string | null;
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
  const [importMode, setImportMode] = useState<"single" | "bulk" | null>(null);
  const [bulkQueue, setBulkQueue] = useState<AuthorFolder[]>([]);
  const [bulkIndex, setBulkIndex] = useState(0);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [purgeBusy, setPurgeBusy] = useState(false);
  const [purgeConfirmOpen, setPurgeConfirmOpen] = useState(false);
  const [selectedModId, setSelectedModId] = useState<number | null>(null);
  const [previewData, setPreviewData] = useState<PreviewInfo | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewImagesBusy, setPreviewImagesBusy] = useState(false);
  const [previewVideosBusy, setPreviewVideosBusy] = useState(false);
  const [previewProgress, setPreviewProgress] =
    useState<PreviewProgressPayload | null>(null);
  const [previewRevision, setPreviewRevision] = useState(0);

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

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    listen<PreviewProgressPayload>("preview-progress", (event) => {
      setPreviewProgress((prev) => ({
        ...event.payload,
        message: event.payload.message ?? prev?.message ?? null,
        current_mod: event.payload.current_mod ?? prev?.current_mod ?? null,
      }));
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((err) => {
        console.error("[preview] failed to register progress listener", err);
      });

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  useEffect(() => {
    if (previewData) {
      console.log("[preview] resolved preview info", previewData);
    } else {
      console.log("[preview] no preview data available");
    }
  }, [previewData, previewRevision]);

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

  const loadPreview = useCallback(async (modId: number) => {
    setPreviewBusy(true);
    setPreviewError(null);
    setPreviewData(null);
    try {
      const info = await invoke<PreviewInfo>("mod_preview_info", { id: modId });
      console.log("[preview] backend reported image path", info.image_path);
      setPreviewData(info);
      setPreviewRevision(Date.now());
    } catch (err) {
      console.error("[preview] failed to load preview", err);
      setPreviewError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewBusy(false);
    }
  }, []);

  const handleSelectMod = useCallback(
    (mod: ModRow) => {
      setSelectedModId(mod.id);
      void loadPreview(mod.id);
    },
    [loadPreview],
  );

  useEffect(() => {
    if (selectedModId === null) return;
    const exists = mods.some((m) => m.id === selectedModId);
    if (!exists) {
      setSelectedModId(null);
      setPreviewData(null);
      setPreviewError(null);
    }
  }, [mods, selectedModId]);

  async function generatePreviewImages() {
    if (previewImagesBusy || previewVideosBusy) return;
    setPreviewImagesBusy(true);
    setPreviewProgress({
      kind: "image",
      status: "running",
      total: 0,
      processed: 0,
      generated: 0,
      skipped: 0,
      errors: 0,
      message: "Preparing preview images...",
    });
    try {
      await invoke<PreviewGenerationSummary>("previews_generate_images");
      if (selectedModId !== null) {
        await loadPreview(selectedModId);
      }
    } catch (err) {
      console.error("[preview] failed to generate images", err);
      const message = err instanceof Error ? err.message : String(err);
      alert(`Failed to generate preview images: ${message}`);
      setPreviewProgress({
        kind: "image",
        status: "error",
        total: 0,
        processed: 0,
        generated: 0,
        skipped: 0,
        errors: 1,
        message,
      });
    } finally {
      setPreviewImagesBusy(false);
    }
  }

  async function generatePreviewVideos() {
    if (previewImagesBusy || previewVideosBusy) return;
    setPreviewVideosBusy(true);
    setPreviewProgress({
      kind: "video",
      status: "running",
      total: 0,
      processed: 0,
      generated: 0,
      skipped: 0,
      errors: 0,
      message: "Preparing preview videos...",
    });
    try {
      await invoke<PreviewGenerationSummary>("previews_generate_videos");
      if (selectedModId !== null) {
        await loadPreview(selectedModId);
      }
    } catch (err) {
      console.error("[preview] failed to generate videos", err);
      const message = err instanceof Error ? err.message : String(err);
      alert(`Failed to generate preview videos: ${message}`);
      setPreviewProgress({
        kind: "video",
        status: "error",
        total: 0,
        processed: 0,
        generated: 0,
        skipped: 0,
        errors: 1,
        message,
      });
    } finally {
      setPreviewVideosBusy(false);
    }
  }

  const rememberAuthorDir = useCallback(
    (dir: string, _author?: string) => {
      if (!dir) return;
      if (settings.last_library_pick === dir) return;
      console.log("[settings] remembering author dir", dir);
      void saveSettings({ ...settings, last_library_pick: dir });
    },
    [settings, saveSettings],
  );

  async function startBulkImportFromLibraries() {
    if (bulkBusy || importMode === "bulk") {
      console.log("[settings] bulk scan already running");
      return;
    }
    const libs = settings.library_dirs || [];
    if (libs.length === 0) {
      alert("Add at least one mods folder first.");
      return;
    }
    setBulkBusy(true);
    try {
      const queue: AuthorFolder[] = [];
      const seenFolders = new Set<string>();
      for (const dir of libs) {
        try {
          const authors = await invoke<AuthorFolder[]>("library_author_dirs", {
            libRoot: dir,
          });
          for (const author of authors) {
            if (seenFolders.has(author.folder_path)) continue;
            seenFolders.add(author.folder_path);
            queue.push(author);
          }
        } catch (err) {
          console.error("[settings] failed to list author folders", dir, err);
        }
      }
      if (queue.length === 0) {
        alert("No author folders found in your mods directories.");
        setBulkQueue([]);
        setImportMode(null);
        setImportOpen(false);
        return;
      }
      console.log(
        `[settings] queued ${queue.length} author folders for import`,
      );
      queue.sort((a, b) => a.folder_path.localeCompare(b.folder_path));
      setBulkQueue(queue);
      setBulkIndex(0);
      setImportMode("bulk");
      setSettingsOpen(false);
      setImportOpen(true);
    } finally {
      setBulkBusy(false);
    }
  }

  function advanceBulk() {
    setImportOpen(false);
    const nextIndex = bulkIndex + 1;
    if (nextIndex >= bulkQueue.length) {
      setImportMode(null);
      setImportOpen(false);
      setBulkQueue([]);
      setBulkIndex(0);
      return;
    }
    setBulkIndex(nextIndex);
    console.log(
      "[settings] moving to next author folder",
      bulkQueue[nextIndex]?.folder_path,
    );
    setTimeout(() => {
      setImportOpen(true);
    }, 0);
  }

  function handlePurgeMods() {
    if (purgeBusy) return;
    setPurgeConfirmOpen(true);
  }

  async function confirmPurgeMods() {
    if (purgeBusy) return;
    setPurgeBusy(true);
    try {
      const removed = await invoke<number>("mods_purge_all");
      console.log(`[settings] purge removed ${removed} mods`);
      refresh();
      setPurgeConfirmOpen(false);
    } catch (err) {
      console.error("[settings] purge failed", err);
      alert(String(err));
    } finally {
      setPurgeBusy(false);
    }
  }

  function handleWizardOpenChange(next: boolean) {
    if (next) {
      setImportOpen(true);
      return;
    }
    if (importMode === "bulk") {
      advanceBulk();
    } else {
      setImportOpen(false);
      setImportMode(null);
    }
  }

  const selectedMod = selectedModId
    ? (mods.find((m) => m.id === selectedModId) ?? null)
    : null;
  const imageSrc = useMemo(() => {
    if (!previewData?.image_path || previewBusy) return null;
    const fileUrl = convertFileSrc(previewData.image_path);
    console.log("[preview] image fileUrl", fileUrl);
    return fileUrl;
  }, [previewData?.image_path, previewBusy]);
  const videoSrc = useMemo(() => {
    if (!previewData?.video_path || previewBusy) return null;
    const fileUrl = convertFileSrc(previewData.video_path);
    console.log("[preview] video fileUrl", fileUrl);
    return fileUrl;
  }, [previewData?.video_path, previewBusy]);

  const handleImageError = useCallback(() => {
    const path = previewData?.image_path ?? "unknown";
    const computedSrc =
      previewData?.image_path && !previewBusy
        ? convertFileSrc(previewData.image_path)
        : null;
    console.error("[preview] image load failed", { path, computedSrc });
    setPreviewError(`Failed to load preview image at ${path}`);
  }, [previewData, previewBusy]);

  const handleVideoError = useCallback(() => {
    const path = previewData?.video_path ?? "unknown";
    const computedSrc =
      previewData?.video_path && !previewBusy
        ? convertFileSrc(previewData.video_path)
        : null;
    console.error("[preview] video load failed", { path, computedSrc });
    setPreviewError(`Failed to load preview video at ${path}`);
  }, [previewData, previewBusy]);

  useEffect(() => {
    if (imageSrc) {
      console.log(
        "[preview] attempting to render image",
        imageSrc,
        "from",
        previewData?.image_path,
      );
    }
    if (videoSrc) {
      console.log(
        "[preview] attempting to render video",
        videoSrc,
        "from",
        previewData?.video_path,
      );
    }
  }, [imageSrc, videoSrc, previewData]);

  const isBulkMode = importMode === "bulk" && bulkQueue.length > 0;
  const currentBulk =
    isBulkMode && bulkIndex < bulkQueue.length ? bulkQueue[bulkIndex] : null;
  const importWizardKey = isBulkMode
    ? (currentBulk?.folder_path ?? `bulk-${bulkIndex}`)
    : "single-import";

  return (
    <div className="h-screen w-screen text-zinc-100">
      {/* Top bar */}
      <div className="h-12 border-b border-zinc-800 px-4 flex items-center justify-between bg-zinc-950/60 backdrop-blur">
        <div className="font-medium">Mod Manager (Tauri)</div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={() => {
              setImportMode("single");
              setImportOpen(true);
            }}
          >
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
        <div className="h-full p-3 overflow-hidden">
          <Card className="h-full overflow-hidden flex flex-col">
            <CardHeader>
              <CardTitle>All Mods</CardTitle>
            </CardHeader>
            <Separator />
            <CardContent className="flex-1 overflow-auto pr-1">
              <ul className="space-y-2 text-sm pr-1">
                {mods.map((m) => {
                  const isSelected = selectedModId === m.id;
                  return (
                    <li
                      key={m.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => handleSelectMod(m)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          handleSelectMod(m);
                        }
                      }}
                      className={`flex items-center justify-between border-b border-zinc-800 py-2 px-2 rounded-md transition-colors ${
                        isSelected
                          ? "bg-zinc-900/70"
                          : "hover:bg-zinc-900/40 focus:bg-zinc-900/50"
                      }`}
                    >
                      <div className="min-w-0 pr-2">
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
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleInstall(m);
                        }}
                      >
                        {m.installed ? "Uninstall" : "Install"}
                      </Button>
                    </li>
                  );
                })}
                {mods.length === 0 && (
                  <li className="opacity-60">
                    No mods yet — add a library folder and hit Rescan.
                  </li>
                )}
              </ul>
            </CardContent>
          </Card>
        </div>

        {/* Right: Preview */}
        <div className="h-full p-3 overflow-hidden">
          <Card className="h-full flex flex-col">
            <CardHeader className="space-y-1">
              <CardTitle>Preview</CardTitle>
              {selectedMod && (
                <div className="text-xs text-zinc-400 truncate">
                  {selectedMod.display_name}
                </div>
              )}
            </CardHeader>
            <Separator />
            <CardContent className="flex-1 overflow-auto">
              {!selectedMod && (
                <div className="h-full grid place-items-center text-sm opacity-60">
                  Select a mod
                </div>
              )}
              {selectedMod && (
                <div className="flex h-full flex-col gap-4">
                  <div>
                    <div className="text-xs text-zinc-400 truncate">
                      {selectedMod.folder_path}
                    </div>
                  </div>
                  {previewBusy && (
                    <div className="text-sm opacity-60">Loading preview...</div>
                  )}
                  {!previewBusy && previewError && (
                    <div className="text-sm text-red-400">{previewError}</div>
                  )}
                  {!previewBusy && !previewError && (
                    <div className="flex flex-col gap-4">
                      {imageSrc ? (
                        <div className="space-y-2">
                          <div className="text-xs uppercase tracking-wide text-zinc-400">
                            Image
                          </div>
                          <img
                            key={previewRevision}
                            src={imageSrc}
                            alt={`${selectedMod.display_name} preview`}
                            className="max-h-[360px] w-full rounded-md border border-zinc-800 object-contain bg-black/40"
                            onError={handleImageError}
                          />
                        </div>
                      ) : null}
                      {videoSrc ? (
                        <div className="space-y-2">
                          <div className="text-xs uppercase tracking-wide text-zinc-400">
                            Video
                          </div>
                          <video
                            key={previewRevision}
                            controls
                            src={videoSrc}
                            className="w-full rounded-md border border-zinc-800 bg-black/40"
                            onError={handleVideoError}
                          />
                        </div>
                      ) : null}
                      {!imageSrc && !videoSrc && (
                        <div className="text-sm opacity-60">
                          No previews found. Generate them from the settings.
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Render the dialog OUTSIDE the grid so it doesn't become a grid item */}
      <ImportWizard
        key={importWizardKey}
        open={importOpen}
        onOpenChange={handleWizardOpenChange}
        onCommitted={refresh}
        initialAuthorDir={
          isBulkMode
            ? currentBulk?.folder_path
            : settings.last_library_pick || undefined
        }
        initialDefaultAuthor={
          isBulkMode ? currentBulk?.inferred_author : undefined
        }
        autoScan={isBulkMode}
        onRememberAuthorDir={rememberAuthorDir}
      />
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={settings}
        onAddLibraryDir={addLibDir}
        onPickGameDir={pickGameDir}
        onScanLibraryDirs={startBulkImportFromLibraries}
        onScanGameMods={() =>
          console.log("[settings] game folder scan not implemented yet")
        }
        onPurgeMods={handlePurgeMods}
        scanLibraryDisabled={bulkBusy || importMode === "bulk"}
        scanGameDisabled={!settings.game_mods_dir}
        purgeDisabled={purgeBusy}
        onCreatePreviewImages={generatePreviewImages}
        onCreatePreviewVideos={generatePreviewVideos}
        createPreviewImagesDisabled={previewImagesBusy || previewVideosBusy}
        createPreviewVideosDisabled={previewImagesBusy || previewVideosBusy}
        previewProgress={previewProgress}
      />
      <Dialog
        open={purgeConfirmOpen}
        onOpenChange={(open) => {
          if (!purgeBusy) setPurgeConfirmOpen(open);
        }}
      >
        <DialogContent className="max-w-sm space-y-4 bg-zinc-950 text-zinc-100">
          <DialogHeader className="space-y-2">
            <DialogTitle className="text-red-400">Delete all mods?</DialogTitle>
            <p className="text-xs text-zinc-400">
              This removes every mod entry from the local database. Installed
              files on disk stay untouched.
            </p>
          </DialogHeader>
          <DialogFooter className="justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => setPurgeConfirmOpen(false)}
              disabled={purgeBusy}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmPurgeMods}
              disabled={purgeBusy}
            >
              {purgeBusy ? "Purging..." : "Yes, delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
