// The prompts: the built-in sample pack plus the venue's own packs (CSV/JSON uploaded on
// /admin). Packs live under DATA_DIR/packs/<id>.json { id, name, createdAt, prompts, standIns }.
// A damaged pack file is skipped (and logged), never fatal.

import { mkdir, readdir, readFile, rename, unlink, writeFile } from "fs/promises";
import path from "path";
import { log, newId } from "@bargames/gamekit/server";
import { MAX_PACK_NAME, SAMPLE_PACK_ID, SAMPLE_PACK_NAME, SAMPLE_PROMPTS, SAMPLE_STANDINS, type PackInfo, type ParsedPack, type Prompt } from "@zinger/shared";
import { DATA_DIR } from "./config.js";

const PACK_DIR = path.join(DATA_DIR, "packs");
export const MAX_PACKS = 100;

interface StoredPack {
  id: string;
  name: string;
  createdAt: number;
  prompts: Prompt[];
  standIns: string[];
}

const packs = new Map<string, StoredPack>();
const SAMPLE: StoredPack = { id: SAMPLE_PACK_ID, name: SAMPLE_PACK_NAME, createdAt: 0, prompts: SAMPLE_PROMPTS, standIns: SAMPLE_STANDINS };

async function writeAtomic(file: string, data: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

export async function initContent(): Promise<void> {
  await mkdir(PACK_DIR, { recursive: true });
  packs.clear();
  for (const f of await readdir(PACK_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      const p = JSON.parse(await readFile(path.join(PACK_DIR, f), "utf8")) as StoredPack;
      if (typeof p.id !== "string" || typeof p.name !== "string" || !Array.isArray(p.prompts)) throw new Error("wrong shape");
      if (!Array.isArray(p.standIns)) p.standIns = [];
      packs.set(p.id, p);
    } catch (err) {
      log.warn("content", "skipped a damaged pack file", { file: f, err: String(err) });
    }
  }
  log.info("content", "loaded packs", { packs: packs.size });
}

const info = (p: StoredPack): PackInfo => ({
  id: p.id,
  name: p.name,
  family: p.prompts.filter((q) => q.tag === "family").length,
  spicy: p.prompts.filter((q) => q.tag === "spicy").length,
  standIns: p.standIns.length,
  builtIn: p.id === SAMPLE_PACK_ID,
});

/** The sample pack first, then the venue's packs, newest first. */
export function listPacks(): PackInfo[] {
  return [info(SAMPLE), ...[...packs.values()].sort((a, b) => b.createdAt - a.createdAt).map(info)];
}

export const hasPack = (id: string): boolean => id === SAMPLE_PACK_ID || packs.has(id);

const packOf = (id: string): StoredPack | undefined => (id === SAMPLE_PACK_ID ? SAMPLE : packs.get(id));

export function packPrompts(id: string): Prompt[] {
  return packOf(id)?.prompts ?? [];
}

/** The chosen packs' stand-ins; the sample's when they have none. */
export function standInsFor(ids: string[]): string[] {
  const all = [...new Set(ids.flatMap((id) => packOf(id)?.standIns ?? []))];
  return all.length >= 4 ? all : [...new Set([...all, ...SAMPLE_STANDINS])];
}

export async function savePack(rawName: string, parsed: ParsedPack): Promise<{ pack: PackInfo; warnings: string[] }> {
  const warnings = [...parsed.warnings];
  if (!parsed.prompts.length) throw new Error(warnings[0] ?? "No prompts found in that file.");
  if (packs.size >= MAX_PACKS) throw new Error(`There are already ${MAX_PACKS} packs. Delete some first.`);
  const name = (rawName.trim() || parsed.name || "My pack").replace(/\s+/g, " ").slice(0, MAX_PACK_NAME);
  const id = `p${newId()}`;
  const prompts: Prompt[] = parsed.prompts.map((q, i) => ({ id: `${id}-${i + 1}`, text: q.text, tag: q.tag }));
  const pack: StoredPack = { id, name, createdAt: Date.now(), prompts, standIns: [...new Set(parsed.standIns)] };
  await writeAtomic(path.join(PACK_DIR, `${id}.json`), JSON.stringify(pack, null, 1));
  packs.set(id, pack);
  log.info("content", "pack saved", { id, name, prompts: prompts.length, standIns: pack.standIns.length, warnings: warnings.length });
  return { pack: info(pack), warnings };
}

export async function deletePack(id: string): Promise<boolean> {
  if (id === SAMPLE_PACK_ID || !packs.has(id)) return false;
  packs.delete(id);
  await unlink(path.join(PACK_DIR, `${id}.json`)).catch(() => undefined);
  log.info("content", "pack deleted", { id });
  return true;
}
