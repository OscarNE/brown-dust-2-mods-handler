import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { invoke } from "@tauri-apps/api/core";
import { open as pick } from "@tauri-apps/plugin-dialog";

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

type CatalogCharacter = {
  id: number;
  slug: string;
  display_name: string;
};

type CatalogCostume = {
  id: number;
  character_id: number;
  slug: string;
  display_name: string;
};

type CatalogResponse = {
  characters: CatalogCharacter[];
  costumes: CatalogCostume[];
};

const AUTHOR_ALIASES: Record<string, string> = {
  mrmiagi: "MrMiagi",
  yukiishida: "Yuk11sh1d4",
  linr: "Linr",
  hcoel: "HCoel",
  hardcracker: "Hardcracker",
  mrperhaps: "MrPerhaps",
  nimloth: "Nimloth",
  sloth: "Sloth",
  synae: "Synae",
  qi: "Qi齊",
  anextra: "AnExtra",
  hiccup: "Hiccup",
  rikudouray: "RikudouRay",
  muslimwomen: "Muslimwomen",
  selin86: "Selin86",
  mahdicc: "Mahdicc",
  bbman: "BBman",
  minki: "Minki",
  // Extend with more aliases as they become known
};

function inferAuthorFromFolderName(folderName: string): string {
  const normalized = folderName
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const sanitized = normalized.replace(/[^a-z0-9]/g, "");
  if (!sanitized) return "unknown";

  let bestAlias: { alias: string; canonical: string } | null = null;
  for (const [alias, canonical] of Object.entries(AUTHOR_ALIASES)) {
    if (sanitized.includes(alias)) {
      if (!bestAlias || alias.length > bestAlias.alias.length) {
        bestAlias = { alias, canonical };
      }
    }
  }

  return bestAlias ? bestAlias.canonical : "unknown";
}

export type DraftMod = {
  display_name: string;
  folder_path: string;
  author?: string;
  download_url?: string;
  mod_type: ModType;
  character_id?: number | null;
  costume_id?: number | null;
  infer_confidence: number;
};

type Props = {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCommitted: () => void;
  initialAuthorDir?: string;
  initialDefaultAuthor?: string;
  autoScan?: boolean;
};

export default function ImportWizard({
  open,
  onOpenChange,
  onCommitted,
  initialAuthorDir,
  initialDefaultAuthor,
  autoScan = false,
}: Props) {
  const [authorDir, setAuthorDir] = useState<string>("");
  const [defaultAuthor, setDefaultAuthor] = useState<string>("");
  const [defaultUrl, setDefaultUrl] = useState<string>("");
  const [drafts, setDrafts] = useState<DraftMod[]>([]);
  const [busy, setBusy] = useState(false);
  const [characters, setCharacters] = useState<CatalogCharacter[]>([]);
  const [costumes, setCostumes] = useState<CatalogCostume[]>([]);

  useEffect(() => {
    if (!open) return;
    refreshCatalog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function refreshCatalog() {
    try {
      const res = await invoke<CatalogResponse>("catalog_list");
      setCharacters(res.characters || []);
      setCostumes(res.costumes || []);
    } catch (e) {
      console.error(e);
      setCharacters([]);
      setCostumes([]);
    }
  }

  // When authorDir changes, try to infer a sensible default author.
  useEffect(() => {
    if (!authorDir) {
      setDefaultAuthor("");
      return;
    }
    const parts = authorDir.split(/[\\/]/).filter(Boolean);
    const last = parts[parts.length - 1] || "";
    if (!last) {
      setDefaultAuthor("");
      return;
    }
    setDefaultAuthor(inferAuthorFromFolderName(last));
  }, [authorDir]);

  useEffect(() => {
    if (!open) return;
    if (initialAuthorDir && initialAuthorDir !== authorDir) {
      setAuthorDir(initialAuthorDir);
    }
  }, [open, initialAuthorDir]);

  useEffect(() => {
    if (!open) return;
    if (initialDefaultAuthor) {
      setDefaultAuthor(initialDefaultAuthor);
    }
  }, [open, initialDefaultAuthor]);

  useEffect(() => {
    if (!open) return;
    if (!initialAuthorDir) return;
    setDrafts([]);
    setDefaultUrl("");
  }, [initialAuthorDir, open]);

  const lastAutoScan = useRef<string | null>(null);

  useEffect(() => {
    if (!open) {
      lastAutoScan.current = null;
      return;
    }
    if (!autoScan) return;
    if (!initialAuthorDir) return;
    if (authorDir !== initialAuthorDir) return;
    if (initialDefaultAuthor && defaultAuthor !== initialDefaultAuthor) return;
    if (lastAutoScan.current === initialAuthorDir) return;
    lastAutoScan.current = initialAuthorDir;
    dryRun();
  }, [
    open,
    autoScan,
    authorDir,
    initialAuthorDir,
    initialDefaultAuthor,
    defaultAuthor,
  ]);

  function costumesForChar(cid?: number | null) {
    if (!cid) return [];
    return costumes.filter((c) => c.character_id === cid);
  }

  async function dryRun() {
    if (!authorDir) return;
    setBusy(true);
    try {
      const result = await invoke<DraftMod[]>("mods_import_dry_run", {
        authorDir,
        defaultAuthor: defaultAuthor || null,
        defaultDownloadUrl: defaultUrl || null,
      });
      // Ensure numeric nulls are null, not undefined
      const deduped = Array.from(
        new Map(
          result.map((r) => [r.folder_path, r]), // last one wins if duplicates
        ).values(),
      );
      setDrafts(
        deduped.map((r) => ({
          ...r,
          character_id: r.character_id ?? null,
          costume_id: r.costume_id ?? null,
        })),
      );
    } catch (e) {
      console.error(e);
      alert(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function commitAll() {
    if (drafts.length === 0) {
      onOpenChange(false);
      return;
    }
    setBusy(true);
    try {
      await invoke("mods_import_commit", { drafts });
      onOpenChange(false);
      onCommitted();
    } catch (e) {
      console.error(e);
      alert(String(e));
    } finally {
      setBusy(false);
    }
  }

  function updateRow(i: number, patch: Partial<DraftMod>) {
    setDrafts((prev) => {
      const next = [...prev];
      next[i] = { ...next[i], ...patch };
      if (patch.character_id !== undefined) {
        next[i].costume_id = null;
      }
      return next;
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl text-zinc-100">
        <DialogHeader>
          <DialogTitle>Import Mods from Author Folder</DialogTitle>
        </DialogHeader>

        {/* Step 1: Pick author folder + defaults */}
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <div className="col-span-2">
                <label className="text-xs text-zinc-300">
                  Author folder (e.g., /mods/SomeAuthor)
                </label>
                <div className="flex gap-2">
                  <Input
                    placeholder="Absolute path to the author folder"
                    value={authorDir}
                    onChange={(e) => setAuthorDir(e.target.value)}
                  />
                  <Button
                    variant="outline"
                    onClick={async () => {
                      const p = await pick({ directory: true });
                      if (typeof p === "string") setAuthorDir(p);
                    }}
                  >
                    Pick Folder
                  </Button>
                </div>
              </div>
            </div>
            <div>
              <label className="text-xs text-zinc-100">Default author</label>
              <Input
                value={defaultAuthor}
                onChange={(e) => setDefaultAuthor(e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs text-zinc-100">
                Default download URL
              </label>
              <Input
                value={defaultUrl}
                onChange={(e) => setDefaultUrl(e.target.value)}
                placeholder="https://..."
              />
            </div>
            <div className="col-span-2 text-xs text-zinc-400">
              Types are inferred from the folder name; adjust individual rows if
              needed.
            </div>
          </div>

          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={dryRun}
              disabled={busy || !authorDir}
            >
              {busy ? "Scanning..." : "Scan Folder"}
            </Button>
          </div>
        </div>

        <Separator className="my-3" />

        {/* Step 2: Edit drafts */}
        <div className="max-h-[45vh] overflow-auto">
          {drafts.length === 0 ? (
            <div className="opacity-60 text-sm">
              No drafts yet. Click “Scan Folder”.
            </div>
          ) : (
            <div className="grid grid-cols-7 gap-2 text-sm">
              <div className="font-medium">Display Name</div>
              <div className="font-medium">Author</div>
              <div className="font-medium">URL</div>
              <div className="font-medium">Type</div>
              <div className="font-medium">Character</div>
              <div className="font-medium">Costume</div>
              <div className="font-medium">Conf</div>

              {drafts.map((d, i) => {
                const costumeOptions = costumesForChar(d.character_id ?? null);
                return (
                  <>
                    <Input
                      value={d.display_name}
                      onChange={(e) =>
                        updateRow(i, { display_name: e.target.value })
                      }
                    />
                    <Input
                      value={d.author || ""}
                      onChange={(e) => updateRow(i, { author: e.target.value })}
                    />
                    <Input
                      value={d.download_url || ""}
                      onChange={(e) =>
                        updateRow(i, { download_url: e.target.value })
                      }
                    />
                    <select
                      className="rounded-md bg-zinc-900 border border-zinc-800 h-9 px-2"
                      value={d.mod_type}
                      onChange={(e) =>
                        updateRow(i, { mod_type: e.target.value as ModType })
                      }
                    >
                      <option value="other">other</option>
                      <option value="idle">idle</option>
                      <option value="cutscene">cutscene</option>
                      <option value="history">history</option>
                      <option value="date">date</option>
                      <option value="minigame">minigame</option>
                      <option value="swap">swap</option>
                      <option value="battle">battle</option>
                      <option value="ui">ui</option>
                    </select>

                    <select
                      className="rounded-md bg-zinc-900 border border-zinc-800 h-9 px-2"
                      value={d.character_id ?? ""}
                      onChange={(e) =>
                        updateRow(i, {
                          character_id: e.target.value
                            ? Number(e.target.value)
                            : null,
                        })
                      }
                    >
                      <option value="">(none)</option>
                      {characters.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.display_name}
                        </option>
                      ))}
                    </select>

                    <select
                      className="rounded-md bg-zinc-900 border border-zinc-800 h-9 px-2"
                      value={d.costume_id ?? ""}
                      onChange={(e) =>
                        updateRow(i, {
                          costume_id: e.target.value
                            ? Number(e.target.value)
                            : null,
                        })
                      }
                      disabled={!d.character_id}
                    >
                      <option value="">(none)</option>
                      {costumeOptions.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.display_name}
                        </option>
                      ))}
                    </select>

                    <div className="self-center text-xs opacity-70">
                      {Math.round((d.infer_confidence || 0) * 100)}%
                    </div>
                  </>
                );
              })}
            </div>
          )}
        </div>

        <DialogFooter className="mt-3">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button onClick={commitAll} disabled={busy || drafts.length === 0}>
            {busy ? "Saving..." : "Save All"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
