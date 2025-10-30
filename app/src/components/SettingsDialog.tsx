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
};

export default function SettingsDialog({
  open,
  onOpenChange,
  settings,
  onAddLibraryDir,
  onPickGameDir,
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
                <Button size="sm" variant="outline">
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
                <Button size="sm" variant="outline">
                  Scan
                </Button>
              </div>
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
