// /admin: the password, rooms, defaults, the writer limit, the venue's packs (CSV/JSON).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "../harness.mjs";
import { room } from "../game.mjs";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "zinger-admin-"));
let server;
let token;

const api = async (p, { method = "GET", body, raw, auth = token } = {}) => {
  const res = await fetch(`${server.url}/api/admin${p}`, {
    method: raw !== undefined || body !== undefined ? (method === "GET" ? "POST" : method) : method,
    headers: { ...(raw === undefined ? { "content-type": "application/json" } : {}), ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

before(async () => {
  server = await startServer({ DATA_DIR: dataDir, ALL_IN_GRACE_MS: "50" });
});
after(async () => {
  await server.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

test("first-run setup, then sign in", async () => {
  assert.equal((await api("/status", { auth: "" })).body.setupNeeded, true);
  const setup = await api("/setup", { method: "POST", body: { password: "correct horse" }, auth: "" });
  assert.equal(setup.status, 200);
  token = setup.body.token;
  assert.equal((await api("/overview")).status, 200);
  assert.equal((await api("/overview", { auth: "wrong" })).status, 401);
  assert.equal((await api("/upload/pack", { raw: "prompt\nx", auth: "wrong" })).status, 401, "uploads need a session too");
});

test("the writer limit: more than 10 writers, by admin option", async () => {
  let o = (await api("/overview")).body;
  assert.equal(o.settings.writerLimit, 10);
  assert.equal(o.settings.roomDefaults.maxWriters, 10);
  assert.equal((await api("/settings", { method: "PUT", body: { writerLimit: 99 } })).status, 400);
  assert.equal((await api("/settings", { method: "PUT", body: { writerLimit: 16, roomDefaults: { maxWriters: 14 } } })).status, 200);
  o = (await api("/overview")).body;
  assert.equal(o.settings.writerLimit, 16);
  assert.equal(o.settings.roomDefaults.maxWriters, 14);

  const names = Array.from({ length: 15 }, (_, i) => `P${i + 1}`);
  const { host, players } = await room(server, names);
  let s = await host.waitFor((v) => v.writerLimit === 16 && v.settings.maxWriters === 14, "room defaults");
  // A host can't go past the limit.
  await host.ok("updateSettings", { maxWriters: 20 });
  s = await host.waitFor((v) => v.settings.maxWriters === 16, "capped at the limit");
  await host.ok("start");
  s = await host.waitFor((v) => v.phase === "write", "writing");
  assert.equal(s.people.filter((p) => p.writer).length, 15);
  const tasks = await players[14].waitFor((v) => v.you.tasks, "the 15th writer writes");
  assert.equal(tasks.you.tasks.length, 2);
  await host.ok("closeRoom");

  // Lowering the limit lowers the defaults with it.
  assert.equal((await api("/settings", { method: "PUT", body: { writerLimit: 8 } })).status, 200);
  o = (await api("/overview")).body;
  assert.equal(o.settings.roomDefaults.maxWriters, 8);
  await api("/settings", { method: "PUT", body: { writerLimit: 10, roomDefaults: { maxWriters: 10 } } });
});

test("a CSV pack with tags and stand-ins; a room plays only it, by rating", async () => {
  const csv = "prompt,tag,standin\nFamily A,family,Stand one\nFamily B,,\nFamily C,family,\nSpicy A,spicy,Stand two\nBad,weird,\n";
  const up = await api("/upload/pack?name=House&file=house.csv", { raw: csv });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.deepEqual([up.body.pack.family, up.body.pack.spicy, up.body.pack.standIns], [3, 1, 2]);
  assert.equal(up.body.warnings.length, 1);
  assert.equal((await api("/upload/pack?file=x.json", { raw: "[]" })).status, 400);

  const packs = (await api("/overview")).body.packs;
  assert.equal(packs[0].id, "sample", "the sample pack is listed first");
  const house = packs.find((p) => p.name === "House");
  await api("/settings", { method: "PUT", body: { roomDefaults: { packIds: [house.id], rating: "family" } } });
  const { host, players } = await room(server, ["Ann", "Bo", "Cy"]);
  await host.ok("start");
  const s = await players[0].waitFor((v) => v.phase === "write" && v.you.tasks, "tasks");
  for (const t of s.you.tasks) assert.match(t.prompt, /^Family [ABC]$/);
  await host.ok("closeRoom");

  // Spicy only, with one spicy prompt and three writers: not enough.
  const r2 = await room(server, ["Dee", "Eve", "Fay"], { settings: { rating: "spicy" } });
  const res = await r2.host.emit("start");
  assert.equal(res.ok, false);
  assert.match(res.error, /enough prompts/);
  await r2.host.ok("closeRoom");
  await api("/settings", { method: "PUT", body: { roomDefaults: { packIds: ["sample"] } } });
});

test("a JSON pack, deleting packs, and they survive a restart", async () => {
  const up = await api("/upload/pack?file=p.json", { raw: JSON.stringify({ name: "Office", prompts: ["One", { prompt: "Two", tag: "spicy" }], standIns: ["Ham"] }) });
  assert.equal(up.body.pack.name, "Office");
  assert.equal((await api("/packs/sample", { method: "DELETE" })).status, 404, "the sample can't be deleted");
  await server.stop();
  server = await startServer({ DATA_DIR: dataDir });
  token = (await api("/login", { method: "POST", body: { password: "correct horse" }, auth: "" })).body.token;
  const names = (await api("/overview")).body.packs.map((p) => p.name);
  assert.deepEqual(names.sort(), ["House", "Office", "Zinger sampler"]);
  const office = (await api("/overview")).body.packs.find((p) => p.name === "Office");
  assert.equal((await api(`/packs/${office.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await api("/overview")).body.packs.length, 2);
});

test("rooms: listed and closed by the admin", async () => {
  const { code, players } = await room(server, ["Zed"]);
  const rooms = (await api("/overview")).body.rooms;
  assert.ok(rooms.some((r) => r.code === code && r.players === 1));
  assert.equal((await api(`/rooms/${code}/close`, { method: "POST" })).status, 200);
  await new Promise((r) => setTimeout(r, 150));
  assert.match(players[0].closedReason, /administrator/);
});
