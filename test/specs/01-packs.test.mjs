// Pack parsing (CSV / JSON), the sample pack, settings sanitizing: pure functions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePack, sanitizeSettings, SAMPLE_PROMPTS, SAMPLE_STANDINS, MAX_PACK_PROMPTS, ANSWER_MAX } from "@zinger/shared";

test("the sample pack: about 150 original prompts, tagged, plus stand-ins", () => {
  assert.ok(SAMPLE_PROMPTS.length >= 150, `${SAMPLE_PROMPTS.length} prompts`);
  assert.ok(SAMPLE_PROMPTS.filter((p) => p.tag === "family").length >= 100);
  assert.ok(SAMPLE_PROMPTS.filter((p) => p.tag === "spicy").length >= 30);
  assert.equal(new Set(SAMPLE_PROMPTS.map((p) => p.id)).size, SAMPLE_PROMPTS.length, "unique ids");
  assert.equal(new Set(SAMPLE_PROMPTS.map((p) => p.text.toLowerCase())).size, SAMPLE_PROMPTS.length, "no duplicate prompts");
  assert.ok(SAMPLE_STANDINS.length >= 30);
  assert.ok(SAMPLE_STANDINS.every((s) => s.length <= ANSWER_MAX));
});

test("CSV with a header: prompt, tag, standin; quotes; stand-in-only rows; a bad tag", () => {
  const p = parsePack('prompt,tag,standin\n"A bad name for a boat, honestly",family,Ham\nA spicy one,spicy,\n,,Tuesday\nOdd one,weird,\nNo tag,,\n', "pack.csv");
  assert.deepEqual(p.prompts, [
    { text: "A bad name for a boat, honestly", tag: "family" },
    { text: "A spicy one", tag: "spicy" },
    { text: "No tag", tag: "family" },
  ]);
  assert.deepEqual(p.standIns, ["Ham", "Tuesday"]);
  assert.equal(p.warnings.length, 1);
  assert.match(p.warnings[0], /^Line 5: unknown tag/);
});

test("CSV without a header (prompt, tag), semicolons, a BOM", () => {
  const p = parsePack("﻿Worst pet name;family\nLate-night one;adult\n", "x.csv");
  assert.deepEqual(
    p.prompts.map((q) => [q.text, q.tag]),
    [
      ["Worst pet name", "family"],
      ["Late-night one", "spicy"],
    ],
  );
});

test("JSON: a list of strings, or { name, prompts, standIns }", () => {
  const list = parsePack('["One", {"prompt":"Two","tag":"spicy"}, {"text":"Three"}, {"tag":"spicy"}]', "p.json");
  assert.deepEqual(
    list.prompts.map((q) => [q.text, q.tag]),
    [
      ["One", "family"],
      ["Two", "spicy"],
      ["Three", "family"],
    ],
  );
  assert.match(list.warnings[0], /^Prompt 4/);
  const named = parsePack('{"name":"Friday","prompts":["A"],"standIns":["Ham","  "]}');
  assert.equal(named.name, "Friday");
  assert.deepEqual(named.standIns, ["Ham"]);
  assert.match(parsePack("{nope", "x.json").warnings[0], /valid JSON/);
});

test("packs are capped", () => {
  const rows = Array.from({ length: MAX_PACK_PROMPTS + 5 }, (_, i) => `Prompt ${i}`).join("\n");
  const p = parsePack(`prompt\n${rows}`, "big.csv");
  assert.equal(p.prompts.length, MAX_PACK_PROMPTS);
  assert.match(p.warnings.at(-1), /first 1000/);
});

test("settings: bad values dropped, writers capped at the admin's limit", () => {
  assert.deepEqual(sanitizeSettings({ writeSeconds: 5, voteSeconds: 20, rating: "x", filter: "yes", maxWriters: 30 }), { voteSeconds: 20 });
  assert.deepEqual(sanitizeSettings({ maxWriters: 16 }, { writerLimit: 10 }), { maxWriters: 10 });
  assert.deepEqual(sanitizeSettings({ maxWriters: 16, rating: "spicy", check: false }, { writerLimit: 20 }), { maxWriters: 16, rating: "spicy", check: false });
  assert.deepEqual(sanitizeSettings({ packIds: ["sample", "gone", 3] }, { knownPacks: (id) => id === "sample" }), { packIds: ["sample"] });
});
