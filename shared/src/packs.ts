// Prompt packs the venue uploads, as CSV or JSON. Pure parsing.

import type { PromptTag } from "./protocol.js";

export const MAX_PACK_PROMPTS = 1000;
export const MAX_PACK_STANDINS = 300;
export const MAX_PROMPT = 120;
export const MAX_STANDIN = 80;
export const MAX_PACK_NAME = 40;

export interface DraftPrompt {
  text: string;
  tag: PromptTag;
}
export interface ParsedPack {
  name?: string;
  prompts: DraftPrompt[];
  standIns: string[];
  /** Lines or items that were skipped, and why. */
  warnings: string[];
}

const clean = (v: unknown, max: number): string =>
  typeof v === "string" || typeof v === "number" ? String(v).replace(/\s+/g, " ").trim().slice(0, max) : "";

/** "spicy", "adult", "18+", "late" → spicy; anything else (or nothing) → family. */
export function parseTag(v: unknown): PromptTag | undefined {
  const t = clean(v, 20).toLowerCase();
  if (!t || t === "family" || t === "clean" || t === "pg") return "family";
  if (t === "spicy" || t === "adult" || t === "18+" || t === "21+" || t === "late" || t === "nsfw") return "spicy";
  return undefined;
}

/** The separator, from the first line: tab, else comma, else semicolon (European Excel). */
function delimiterOf(s: string): string {
  const first = s.split(/\r?\n/, 1)[0] ?? "";
  if (first.includes("\t")) return "\t";
  if (first.includes(",")) return ",";
  return first.includes(";") ? ";" : ",";
}

/** RFC 4180-style CSV: quoted fields, "" escapes, separators/newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  const sep = delimiterOf(s);
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === "") quoted = true;
    else if (c === sep) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

const PROMPT_COLS = new Set(["prompt", "question", "text"]);
const TAG_COLS = new Set(["tag", "rating", "type"]);
const STANDIN_COLS = new Set(["standin", "stand_in", "stand-in", "fallback", "backup"]);

/**
 * CSV with a header row: `prompt` and optionally `tag` (family / spicy) and `standin` (a
 * safe joke used when someone doesn't answer; a row may hold only one). No header: the
 * first column is the prompt, the second its tag.
 */
export function parseCsvPack(text: string): ParsedPack {
  const rows = parseCsv(text);
  const out: ParsedPack = { prompts: [], standIns: [], warnings: [] };
  if (!rows.length) return { ...out, warnings: ["The file is empty."] };
  const head = rows[0]!.map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  const find = (set: Set<string>) => head.findIndex((h) => set.has(h));
  let p = find(PROMPT_COLS);
  let t = find(TAG_COLS);
  const s = find(STANDIN_COLS);
  const hasHeader = p >= 0 || s >= 0;
  if (!hasHeader) {
    p = 0;
    t = 1;
  }
  rows.slice(hasHeader ? 1 : 0).forEach((r, i) => {
    const line = i + (hasHeader ? 2 : 1);
    const prompt = p >= 0 ? clean(r[p], MAX_PROMPT) : "";
    const standIn = s >= 0 ? clean(r[s], MAX_STANDIN) : "";
    if (standIn) out.standIns.push(standIn);
    if (!prompt) {
      if (!standIn) out.warnings.push(`Line ${line}: no prompt.`);
      return;
    }
    const tag = parseTag(t >= 0 ? r[t] : undefined);
    if (!tag) out.warnings.push(`Line ${line}: unknown tag "${r[t]}" (use family or spicy); skipped.`);
    else out.prompts.push({ text: prompt, tag });
  });
  return cap(out);
}

/**
 * JSON: { "name", "prompts": [...], "standIns": [...] }, or just an array of prompts. A
 * prompt is a string (family) or { "prompt": "…", "tag": "spicy" } ("text" works too).
 */
export function parseJsonPack(text: string): ParsedPack {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    return { prompts: [], standIns: [], warnings: ["That isn't valid JSON."] };
  }
  const obj = (data ?? {}) as { name?: unknown; prompts?: unknown; standIns?: unknown; standins?: unknown };
  const list = Array.isArray(data) ? data : Array.isArray(obj.prompts) ? obj.prompts : null;
  const standList = Array.isArray(data) ? [] : Array.isArray(obj.standIns) ? obj.standIns : Array.isArray(obj.standins) ? obj.standins : [];
  if (!list && !standList.length) return { prompts: [], standIns: [], warnings: ['Expected a list of prompts, or { "prompts": [...] }.'] };
  const out: ParsedPack = { prompts: [], standIns: [], warnings: [] };
  (list ?? []).forEach((item, i) => {
    const o = (typeof item === "string" ? { prompt: item } : (item ?? {})) as Record<string, unknown>;
    const prompt = clean(o.prompt ?? o.text, MAX_PROMPT);
    if (!prompt) return void out.warnings.push(`Prompt ${i + 1}: no text.`);
    const tag = parseTag(o.tag ?? o.rating);
    if (!tag) return void out.warnings.push(`Prompt ${i + 1}: unknown tag "${String(o.tag ?? o.rating)}" (use family or spicy); skipped.`);
    out.prompts.push({ text: prompt, tag });
  });
  for (const s of standList) {
    const t = clean(s, MAX_STANDIN);
    if (t) out.standIns.push(t);
  }
  out.name = clean(Array.isArray(data) ? undefined : obj.name, MAX_PACK_NAME) || undefined;
  return cap(out);
}

function cap(p: ParsedPack): ParsedPack {
  if (p.prompts.length > MAX_PACK_PROMPTS) {
    p.warnings.push(`Only the first ${MAX_PACK_PROMPTS} prompts were kept.`);
    p.prompts = p.prompts.slice(0, MAX_PACK_PROMPTS);
  }
  if (p.standIns.length > MAX_PACK_STANDINS) {
    p.warnings.push(`Only the first ${MAX_PACK_STANDINS} stand-ins were kept.`);
    p.standIns = p.standIns.slice(0, MAX_PACK_STANDINS);
  }
  return p;
}

/** Picks the parser from the file name (or content when there's no extension). */
export function parsePack(text: string, fileName = ""): ParsedPack {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".json")) return parseJsonPack(text);
  if (lower.endsWith(".csv") || lower.endsWith(".tsv") || lower.endsWith(".txt")) return parseCsvPack(text);
  const t = text.trimStart();
  return t.startsWith("[") || t.startsWith("{") ? parseJsonPack(text) : parseCsvPack(text);
}
