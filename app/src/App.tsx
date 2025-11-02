import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
import { readFile } from "@tauri-apps/plugin-fs";
import ImportWizard from "@/components/ImportWizard";
import ErrorBoundary from "@/components/ErrorBoundary";
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
  video_mp4_path?: string | null;
  video_webm_path?: string | null;
};
type PreviewProgressPayload = {
  kind: "image" | "video";
  status: "running" | "done" | "error" | "cancelled";
  total: number;
  processed: number;
  generated: number;
  skipped: number;
  errors: number;
  current_mod?: string | null;
  message?: string | null;
};

function guessVideoMime(path?: string | null) {
  if (!path) return "application/octet-stream";
  const lower = path.toLowerCase();
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mp4") || lower.endsWith(".m4v")) return "video/mp4";
  if (lower.endsWith(".ogg") || lower.endsWith(".ogv")) return "video/ogg";
  return "application/octet-stream";
}
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
  const [searchText, setSearchText] = useState("");
  const [videoBlobUrl, setVideoBlobUrl] = useState<string | null>(null);
  const [previewCancelRequested, setPreviewCancelRequested] = useState(false);
  const previewProgressPercent = useMemo(() => {
    if (!previewProgress) return 0;
    if (previewProgress.total > 0) {
      return Math.min(
        100,
        Math.round((previewProgress.processed / previewProgress.total) * 100),
      );
    }
    return previewProgress.status === "done" ||
      previewProgress.status === "cancelled"
      ? 100
      : 0;
  }, [previewProgress]);
  const previewProgressLabel =
    previewProgress?.kind === "video" ? "Video previews" : "Image previews";
  const previewProgressStatus =
    previewProgress?.status === "done"
      ? "Completed"
      : previewProgress?.status === "error"
        ? "Error"
        : previewProgress?.status === "cancelled"
          ? "Cancelled"
          : "In progress";
  const isPreviewRunning = previewProgress?.status === "running";
  const previewProgressMessageClass =
    previewProgress?.status === "error"
      ? "text-red-400"
      : previewProgress?.status === "cancelled"
        ? "text-zinc-400"
        : "text-amber-300";
  const shouldShowProgressPercent =
    !!previewProgress &&
    previewProgress.total > 0 &&
    (isPreviewRunning ||
      previewProgress.status === "done" ||
      previewProgress.status === "cancelled");
  const clearPreviewProgress = useCallback(() => {
    setPreviewProgress(null);
    setPreviewCancelRequested(false);
  }, []);
  const cancelPreviewGeneration = useCallback(() => {
    if (!previewProgress || previewProgress.status !== "running") return;
    const kind = previewProgress.kind;
    setPreviewCancelRequested(true);
    setPreviewProgress((prev) =>
      prev && prev.status === "running"
        ? { ...prev, message: "Cancelling..." }
        : prev,
    );
    void invoke("previews_cancel", { kind }).catch((err) => {
      console.error("[preview] failed to cancel generation", err);
    });
  }, [previewProgress]);

  const refresh = useCallback(() => {
    const trimmed = searchText.trim();
    const filter = trimmed.length > 0 ? { q: trimmed } : null;
    invoke<ModRow[]>("mods_list", { filter })
      .then((rows) => {
        const sorted = [...rows].sort((a, b) =>
          a.display_name.localeCompare(b.display_name, undefined, {
            sensitivity: "base",
          }),
        );
        setMods(sorted);
      })
      .catch(console.error);
  }, [searchText]);

  useEffect(() => {
    invoke<string>("app_version")
      .then(setVersion)
      .catch(() => setVersion("dev"));
    invoke<string>("db_init").catch(console.error);
    loadSettings();
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

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

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    listen<PreviewProgressPayload>("preview-progress", (event) => {
      console.log("[UI] EVENT RECEIVED", event.payload);
      setPreviewProgress((prev) => {
        console.log("[UI] STATE MERGE", prev, event.payload);
        const next = event.payload;
        return {
          ...next,
          message: next.message ?? prev?.message ?? null,
          current_mod: next.current_mod ?? prev?.current_mod ?? null,
        };
      });
      if (event.payload.status !== "running") {
        if (event.payload.kind === "image") {
          setPreviewImagesBusy(false);
        }
        if (event.payload.kind === "video") {
          setPreviewVideosBusy(false);
        }
        if (selectedModId !== null) {
          void loadPreview(selectedModId);
        }
      }
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
  }, [loadPreview, selectedModId]);

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

  const generatePreviewImages = useCallback(() => {
    if (previewImagesBusy || previewVideosBusy) return;
    console.log("[UI] START: setting running state (images)");
    setPreviewImagesBusy(true);
    setPreviewCancelRequested(false);
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
    console.log("[UI] STATE SET: running (images)");
    invoke("previews_generate_images").catch((err) => {
      console.error("[preview] failed to start image generation", err);
      const message = err instanceof Error ? err.message : String(err);
      alert(`Failed to start preview images: ${message}`);
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
      setPreviewImagesBusy(false);
    });
  }, [previewImagesBusy, previewVideosBusy]);

  const generatePreviewVideos = useCallback(() => {
    if (previewImagesBusy || previewVideosBusy) return;
    console.log("[UI] START: setting running state (videos)");
    setPreviewVideosBusy(true);
    setPreviewCancelRequested(false);
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
    console.log("[UI] STATE SET: running (videos)");
    invoke("previews_generate_videos").catch((err) => {
      console.error("[preview] failed to start video generation", err);
      const message = err instanceof Error ? err.message : String(err);
      alert(`Failed to start preview videos: ${message}`);
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
      setPreviewVideosBusy(false);
    });
  }, [previewImagesBusy, previewVideosBusy]);

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
    try {
      const safeUrl = new URL(fileUrl).toString();
      if (safeUrl !== fileUrl) {
        console.log("[preview] sanitized image URL", safeUrl);
      }
      return safeUrl;
    } catch {
      return fileUrl;
    }
  }, [previewData?.image_path, previewBusy]);
  const selectedVideoPath = useMemo(() => {
    if (previewBusy) return null;
    if (previewData?.video_webm_path) return previewData.video_webm_path;
    if (previewData?.video_mp4_path) return previewData.video_mp4_path;
    if (previewData?.video_path) return previewData.video_path;
    return null;
  }, [
    previewBusy,
    previewData?.video_mp4_path,
    previewData?.video_path,
    previewData?.video_webm_path,
  ]);
  const selectedVideoMime = useMemo(
    () => guessVideoMime(selectedVideoPath),
    [selectedVideoPath],
  );
  useEffect(() => {
    let revoked: string | null = null;
    let cancelled = false;

    async function loadBlob(path: string) {
      try {
        const bytes = await readFile(path);
        if (cancelled) {
          return;
        }
        const blob = new Blob([bytes], { type: guessVideoMime(path) });
        const url = URL.createObjectURL(blob);
        revoked = url;
        setVideoBlobUrl(url);
      } catch (error) {
        if (cancelled) return;
        console.error("[preview] blob load failed", error);
        setVideoBlobUrl(null);
        setPreviewError(`Failed to load preview video at ${path}`);
      }
    }

    setVideoBlobUrl(null);
    if (previewBusy) {
      return () => {
        cancelled = true;
        if (revoked) {
          URL.revokeObjectURL(revoked);
        }
      };
    }

    if (selectedVideoPath) {
      void loadBlob(selectedVideoPath);
    }

    return () => {
      cancelled = true;
      if (revoked) {
        URL.revokeObjectURL(revoked);
      }
    };
  }, [previewBusy, previewRevision, selectedVideoPath]);
  const hasVideo = Boolean(videoBlobUrl);

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
    const path = selectedVideoPath ?? "unknown";
    const computedSrc = !previewBusy ? videoBlobUrl : null;
    console.error("[preview] video load failed", { path, computedSrc });
    setVideoBlobUrl(null);
    setPreviewError(`Failed to load preview video at ${path}`);
  }, [previewBusy, selectedVideoPath, videoBlobUrl]);

  useEffect(() => {
    if (imageSrc) {
      console.log(
        "[preview] attempting to render image",
        imageSrc,
        "from",
        previewData?.image_path,
      );
    }
    if (videoBlobUrl && selectedVideoPath) {
      console.log(
        "[preview] attempting to render video blob",
        videoBlobUrl,
        "from",
        selectedVideoPath,
      );
    }
  }, [imageSrc, previewData, selectedVideoPath, videoBlobUrl]);
  useEffect(() => {
    if (!previewProgress || previewProgress.status !== "running") {
      setPreviewCancelRequested(false);
    }
  }, [previewProgress]);

  const isBulkMode = importMode === "bulk" && bulkQueue.length > 0;
  const currentBulk =
    isBulkMode && bulkIndex < bulkQueue.length ? bulkQueue[bulkIndex] : null;
  const importWizardKey = isBulkMode
    ? (currentBulk?.folder_path ?? `bulk-${bulkIndex}`)
    : "single-import";

  return (
    <div className="flex h-screen w-screen flex-col text-zinc-100">
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

      {previewProgress && (
        <div className="border-b border-zinc-800/80 bg-zinc-950/50 px-4 py-3 text-xs sm:text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="font-medium uppercase tracking-wide text-zinc-300">
              {previewProgressLabel}
            </div>
            <div className="flex items-center gap-3 text-zinc-400">
              <span>
                {previewProgressStatus}
                {shouldShowProgressPercent
                  ? ` • ${previewProgressPercent}%`
                  : ""}
              </span>
              {isPreviewRunning ? (
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={cancelPreviewGeneration}
                  disabled={previewCancelRequested}
                >
                  {previewCancelRequested ? "Cancelling..." : "Cancel"}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={clearPreviewProgress}
                >
                  Close
                </Button>
              )}
            </div>
          </div>
          <div className="mt-2 h-2 w-full rounded bg-zinc-800">
            <div
              className={`h-2 rounded transition-all ${
                previewProgress.status === "error"
                  ? "bg-red-500"
                  : "bg-emerald-500"
              }`}
              style={{ width: `${previewProgressPercent}%` }}
            />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
            <span>
              {previewProgress.processed}/{previewProgress.total}
            </span>
            <span>generated {previewProgress.generated}</span>
            <span>skipped {previewProgress.skipped}</span>
            <span>errors {previewProgress.errors}</span>
            {previewProgress.current_mod ? (
              <span className="truncate text-zinc-400">
                Current: {previewProgress.current_mod}
              </span>
            ) : null}
            {previewProgress.message ? (
              <span className={previewProgressMessageClass}>
                {previewProgress.message}
              </span>
            ) : null}
          </div>
        </div>
      )}

      {/* Body grid */}
      <div className="flex-1 grid grid-cols-[35%_65%]">
        {/* Left: List */}
        <div className="h-full p-3 overflow-hidden">
          <Card className="h-full overflow-hidden flex flex-col">
            <CardHeader className="space-y-3">
              <CardTitle>All Mods</CardTitle>
              <Input
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
                placeholder="Search mods..."
                className="h-9 text-sm"
                aria-label="Search mods"
              />
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
                    {searchText.trim().length > 0
                      ? "No mods match your search."
                      : "No mods yet — add a library folder and hit Rescan."}
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
            <CardContent className="flex-1 overflow-hidden">
              {!selectedMod && (
                <div className="h-full grid place-items-center text-sm opacity-60">
                  Select a mod
                </div>
              )}
              {selectedMod && (
                <ErrorBoundary
                  fallback={
                    <div className="text-sm text-red-400">
                      Failed to render preview.
                    </div>
                  }
                >
                  <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden">
                    {previewBusy && (
                      <div className="text-sm opacity-60">
                        Loading preview...
                      </div>
                    )}
                    {!previewBusy && previewError && (
                      <div className="text-sm text-red-400">{previewError}</div>
                    )}
                    {!previewBusy && !previewError && (
                      <div className="flex flex-1 min-h-0 flex-col gap-4 overflow-hidden">
                        {hasVideo ? (
                          <div className="flex-1 min-h-0 space-y-2">
                            <div className="text-xs uppercase tracking-wide text-zinc-400">
                              Video
                            </div>
                            <video
                              key={previewRevision}
                              controls
                              preload="metadata"
                              className="w-full rounded-md border border-zinc-800 bg-black/40"
                              onError={handleVideoError}
                            >
                              {videoBlobUrl ? (
                                <source
                                  src={videoBlobUrl}
                                  type={selectedVideoMime}
                                />
                              ) : selectedVideoPath ? (
                                <source
                                  src={convertFileSrc(selectedVideoPath)}
                                  type={selectedVideoMime}
                                />
                              ) : null}
                              Your system can’t play this video.
                            </video>
                          </div>
                        ) : imageSrc ? (
                          <div className="flex-1 min-h-0 overflow-hidden rounded-md border border-zinc-800 bg-black/40">
                            <img
                              key={previewRevision}
                              src={imageSrc}
                              alt={`${selectedMod.display_name} preview`}
                              className="h-full w-full object-contain"
                              onError={handleImageError}
                            />
                          </div>
                        ) : (
                          <div className="text-sm opacity-60">
                            No preview media available.
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </ErrorBoundary>
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
        onCancelPreview={cancelPreviewGeneration}
        onClearPreviewProgress={clearPreviewProgress}
        cancelPreviewDisabled={previewCancelRequested}
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
