import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";

type SettingsData = {
  library_dirs: string[];
  game_mods_dir?: string | null;
  install_strategy?: string | null;
  last_library_pick?: string | null;
};

type PreviewProgressData = {
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

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: SettingsData;
  onAddLibraryDir: () => void;
  onPickGameDir: () => void;
  onScanLibraryDirs: () => void;
  onScanGameMods: () => void;
  onPurgeMods: () => void;
  scanLibraryDisabled?: boolean;
  scanGameDisabled?: boolean;
  purgeDisabled?: boolean;
  onCreatePreviewImages: () => void;
  onCreatePreviewVideos: () => void;
  createPreviewImagesDisabled?: boolean;
  createPreviewVideosDisabled?: boolean;
  previewProgress?: PreviewProgressData | null;
  onCancelPreview: () => void;
  onClearPreviewProgress: () => void;
  cancelPreviewDisabled?: boolean;
};

export default function SettingsDialog({
  open,
  onOpenChange,
  settings,
  onAddLibraryDir,
  onPickGameDir,
  onScanLibraryDirs,
  onScanGameMods,
  onPurgeMods,
  scanLibraryDisabled = false,
  scanGameDisabled = false,
  purgeDisabled = false,
  onCreatePreviewImages,
  onCreatePreviewVideos,
  createPreviewImagesDisabled = false,
  createPreviewVideosDisabled = false,
  previewProgress = null,
  onCancelPreview,
  onClearPreviewProgress,
  cancelPreviewDisabled = false,
}: Props) {
  const libraries = settings.library_dirs || [];
  const isRunning = previewProgress?.status === "running";
  const disableImageButton = createPreviewImagesDisabled || isRunning;
  const disableVideoButton = createPreviewVideosDisabled || isRunning;
  const cancelDisabled = cancelPreviewDisabled || !isRunning;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl text-zinc-100">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          <section className="space-y-3">
            <div>
              <div className="text-sm font-medium">All Mods Folder</div>
              <div className="text-xs text-zinc-400">
                Folder where you store all your mods.
              </div>
            </div>
            <div className="space-y-2">
              {libraries.length === 0 ? (
                <Input readOnly value="" placeholder="No folder selected yet" />
              ) : (
                libraries.map((dir) => <Input key={dir} readOnly value={dir} />)
              )}
              <div className="flex gap-2">
                <Button size="sm" onClick={onAddLibraryDir}>
                  Add Mods Folder
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onScanLibraryDirs}
                  disabled={scanLibraryDisabled || libraries.length === 0}
                >
                  Scan
                </Button>
              </div>
            </div>
          </section>

          <Separator />

          <section className="space-y-3">
            <div>
              <div className="text-sm font-medium">Game Mods Folder</div>
              <div className="text-xs text-zinc-400">
                Folder in the game where mods are to be installed.
              </div>
            </div>
            <div className="space-y-2">
              <Input
                readOnly
                value={settings.game_mods_dir || ""}
                placeholder="No folder selected yet"
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={onPickGameDir}>
                  Pick Game Folder
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onScanGameMods}
                  disabled={scanGameDisabled}
                >
                  Scan
                </Button>
              </div>
            </div>
          </section>

          <Separator />

          <section className="space-y-3">
            <div>
              <div className="text-sm font-medium">Preview Assets</div>
              <div className="text-xs text-zinc-400">
                Generate missing previews for each registered mod folder.
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                onClick={onCreatePreviewImages}
                disabled={disableImageButton}
              >
                {isRunning && previewProgress?.kind === "image"
                  ? "Generating..."
                  : "Create preview images"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={onCreatePreviewVideos}
                disabled={disableVideoButton}
              >
                {isRunning && previewProgress?.kind === "video"
                  ? "Generating..."
                  : "Create preview videos"}
              </Button>
              {previewProgress ? (
                isRunning ? (
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={onCancelPreview}
                    disabled={cancelDisabled}
                  >
                    {cancelDisabled ? "Cancelling..." : "Cancel"}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={onClearPreviewProgress}
                  >
                    Close
                  </Button>
                )
              ) : null}
            </div>
          </section>

          <Separator />

          <section className="space-y-3 rounded-md border border-red-900/60 bg-red-950/20 p-3">
            <div className="text-sm font-medium text-red-400">Danger Zone</div>
            <div className="text-xs text-red-300">
              Purging deletes every mod entry from the database. This cannot be
              undone.
            </div>
            <Button
              size="sm"
              variant="destructive"
              onClick={onPurgeMods}
              disabled={purgeDisabled}
            >
              Purge Mods
            </Button>
          </section>
        </div>

        <DialogFooter className="mt-6">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
