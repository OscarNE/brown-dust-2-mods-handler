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

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: SettingsData;
  onAddLibraryDir: () => void;
  onPickGameDir: () => void;
  onImportCatalog: () => void;
};

export default function SettingsDialog({
  open,
  onOpenChange,
  settings,
  onAddLibraryDir,
  onPickGameDir,
  onImportCatalog,
}: Props) {
  const libraries = settings.library_dirs || [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl text-zinc-100">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          <section className="space-y-3">
            <div>
              <div className="text-sm font-medium">Library folders</div>
              <div className="text-xs text-zinc-400">
                Choose folders to scan for author sub-directories.
              </div>
            </div>
            <div className="space-y-2">
              {libraries.length === 0 && (
                <div className="text-xs text-zinc-400">
                  No folders configured yet.
                </div>
              )}
              {libraries.map((dir) => (
                <Input key={dir} readOnly value={dir} />
              ))}
              <Button size="sm" onClick={onAddLibraryDir}>
                Add Library Folder
              </Button>
            </div>
          </section>

          <Separator />

          <section className="space-y-3">
            <div className="text-sm font-medium">Catalog data</div>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={onImportCatalog}>
                Import Catalog JSON
              </Button>
            </div>
          </section>

          <Separator />

          <section className="space-y-3">
            <div className="text-sm font-medium">Game mods folder</div>
            <div className="flex items-center gap-2">
              <Input
                readOnly
                value={settings.game_mods_dir || ""}
                placeholder="Not set"
              />
              <Button size="sm" onClick={onPickGameDir}>
                Pick
              </Button>
            </div>
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
