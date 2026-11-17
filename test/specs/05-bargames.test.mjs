// Bar Games (BARGAMES.md): standalone stays standalone; on a (fake) box the commands, status,
// events, results and hosting from the box work.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { io } from "socket.io-client";
import { DEFAULT_GAME_NAME } from "@zinger/shared";
import { fakeCore, sleep, startServer } from "../harness.mjs";
import { room, writeAll } from "../game.mjs";

const TOKEN = "test-token";

describe("standalone (no BG_* env)", () => {
  let server;
  before(async () => {
    server = await startServer({ BG_CORE_URL: "", BG_GAME_TOKEN: "", BG_GAME_ID: "" });
  });
  after(() => server.stop());

  test("the game's own name, and venue.json says standalone", async () => {
    assert.deepEqual(await (await fetch(`${server.url}/api/config`)).json(), { gameName: DEFAULT_GAME_NAME });
    const venue = await (await fetch(`${server.url}/__bargames/venue.json`)).json();
    assert.equal(venue.standalone, true);
  });

  test("GAME_NAME still wins standalone", async () => {
    const named = await startServer({ GAME_NAME: "Friday Zingers" });
    try {
      assert.equal((await (await fetch(`${named.url}/api/config`)).json()).gameName, "Friday Zingers");
    } finally {
      await named.stop();
    }
  });
});

describe("on a box", () => {
  let server, core;
  before(async () => {
    core = await fakeCore(TOKEN);
    server = await startServer({ BG_GAME_ID: "zinger", BG_CORE_URL: core.url, BG_GAME_TOKEN: TOKEN, ALL_IN_GRACE_MS: "50" });
  });
  after(async () => {
    await server.stop();
    await core.close();
  });

  const cmd = async (command, roomCode, args) => {
    const res = await fetch(`${server.url}/__bargames/command`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ command, roomCode, args }),
    });
    return res.json();
  };
  const status = async () => (await (await fetch(`${server.url}/__bargames/status`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()).rooms;
  const statusOf = async (code) => (await status()).find((r) => r.code === code);

  test("the venue's name for the game", async () => {
    assert.equal((await (await fetch(`${server.url}/api/config`)).json()).gameName, "Zinger at Test Bar");
  });

  test("create_room: a venue room with no host phone, driven by start / pause / resume / next_round / end", async () => {
    const made = await cmd("create_room", undefined, { kind: "venue", title: "Friday" });
    assert.equal(made.ok, true);
    const code = made.data.roomCode;
    assert.match(made.data.hostUrl, new RegExp(`^/join/${code}\\?host=`));
    let s = await statusOf(code);
    assert.equal(s.kind, "venue");
    assert.equal(s.phase, "lobby");
    assert.equal(s.joinPath, `/join/${code}`);
    assert.match(s.title, /^Friday · Lobby/);
    await core.waitFor((e) => e.type === "room_created" && e.roomCode === code, "room_created");

    const tv = await server.client();
    await tv.ok("joinRoom", { code, role: "table" });
    const players = [];
    for (const name of ["Ann", "Bo", "Cy"]) {
      const p = await server.client();
      const j = await p.ok("joinRoom", { code, role: "player", name });
      assert.equal(j.role, "player", "no first-joiner offer: a plain player");
      p.name = name;
      players.push(p);
    }
    assert.equal(tv.state.you.plays, false);

    assert.equal((await cmd("next_round", code)).ok, false, "not started");
    assert.equal((await cmd("pause", code)).ok, false, "nothing to pause in the lobby");
    assert.equal((await cmd("start", code)).ok, true);
    assert.match((await cmd("start", code)).message, /already started/);
    const started = await core.waitFor((e) => e.type === "round_started" && e.roomCode === code, "round_started");
    assert.deepEqual(started.data, { round: 1, final: false, writers: 3 });
    s = await statusOf(code);
    assert.equal(s.phase, "write");
    assert.equal(s.players, 3);
    assert.equal(s.tables, 1);

    assert.equal((await cmd("pause", code)).ok, true);
    assert.match((await cmd("pause", code)).message, /already paused/);
    await tv.waitFor((v) => v.paused, "paused");
    assert.match((await statusOf(code)).title, /\(paused\)/);
    assert.equal((await cmd("resume", code)).ok, true);
    assert.match((await cmd("resume", code)).message, /isn't paused/);

    // No runner is connected: the check step is skipped (it's on by default).
    await writeAll(players);
    await tv.waitFor((v) => v.phase === "vote" && v.faceoff, "voting");
    // next_round reveals now, then moves to the next face-off.
    assert.equal((await cmd("next_round", code)).ok, true);
    await tv.waitFor((v) => v.phase === "reveal", "reveal");
    for (let i = 0; i < 5; i++) assert.equal((await cmd("next_round", code)).ok, true); // f2 vote, reveal, f3 vote, reveal, scores
    await tv.waitFor((v) => v.phase === "scores", "scores");
    const ended = await core.waitFor((e) => e.type === "round_ended" && e.roomCode === code, "round_ended");
    assert.equal(ended.data.round, 1);
    assert.equal((await cmd("next_round", code)).ok, true);
    await core.waitFor((e) => e.type === "round_started" && e.roomCode === code && e.data.round === 2, "round 2");

    assert.equal((await cmd("end", code)).ok, true);
    await core.waitFor((e) => e.type === "game_over" && e.roomCode === code, "game_over on end");
    const closed = await core.waitFor((e) => e.type === "room_closed" && e.roomCode === code, "room_closed");
    assert.equal(closed.data.reason, "host");
    assert.equal(await statusOf(code), undefined, "gone from status");
    assert.match(players[0].closedReason, /host ended/);
  });

  test("unknown room and wrong state", async () => {
    for (const c of ["start", "next_round", "pause", "resume", "end", "host_link", "cohost_link"]) {
      const r = await cmd(c, "ZZZZ");
      assert.equal(r.ok, false, c);
      assert.equal(r.message, "no such room");
    }
    const { code, host } = await room(server, ["Ann", "Bo"]);
    assert.match((await cmd("start", code)).message, /at least 3/);
    await host.ok("setPlaying", true);
    await host.ok("start");
    await host.ok("endGame");
    assert.match((await cmd("start", code)).message, /game is over/);
    assert.match((await cmd("resume", code)).message, /isn't paused/);
    assert.equal((await cmd("next_round", code)).ok, true, "next_round from the end screen plays again");
    await host.waitFor((s) => s.phase === "write");
    await host.ok("closeRoom");
  });

  test("a Zinger: x-zinger-sweep; the end: winner, game_over and results for the leaderboards", async () => {
    const { code, host, players } = await room(server, ["Ann", "Bo", "Cy", "Di"]);
    await host.ok("start");
    await writeAll(players);
    let s = await host.waitFor((v) => v.phase === "vote" && v.faceoff, "voting");
    const authors = s.faceoff.answers.map((a) => a.text.split(" ")[0]);
    for (const p of players) if (!authors.includes(p.name)) await p.ok("vote", 1);
    s = await host.waitFor((v) => v.phase === "reveal", "reveal");
    const sweep = await core.waitFor((e) => e.type === "x-zinger-sweep" && e.roomCode === code, "x-zinger-sweep");
    assert.deepEqual(sweep.data, { round: 1, name: authors[1], votes: 2 });
    await host.ok("endGame");
    const over = await core.waitFor((e) => e.type === "game_over" && e.roomCode === code, "game_over");
    assert.deepEqual(over.data.winners, [authors[1]]);
    assert.deepEqual(
      core.of("winner", code).map((e) => e.data),
      [{ name: authors[1], score: 450 }],
    );
    await sleep(200);
    const res = core.results.find((r) => r.roomCode === code);
    assert.ok(res, "reportResults");
    assert.equal(res.results.length, 4, "writers only");
    assert.deepEqual(res.results[0], { player: { name: authors[1] }, place: 1, score: 450 });
    assert.ok(res.results.slice(1).every((r) => r.place === 2 && r.score === 0));
    await host.ok("closeRoom");
  });

  test("first joiner hosts (and plays), and the offer closes when staff open the host link first", async () => {
    const made = await cmd("create_room", undefined, { kind: "venue", firstJoinerHosts: true });
    const code = made.data.roomCode;
    const first = await server.client();
    const joined = await first.ok("joinRoom", { code, role: "player", name: "Ann" });
    assert.equal(joined.role, "host");
    const second = await server.client();
    assert.equal((await second.ok("joinRoom", { code, role: "player", name: "Bo" })).role, "player");
    const s = await first.waitFor((v) => v.people.length === 2, "two in");
    assert.equal(s.you.plays, true, "the first joiner plays too");

    const made2 = await cmd("create_room", undefined, { kind: "venue", firstJoinerHosts: true });
    const key = new URL(made2.data.hostUrl, "http://x").searchParams.get("host");
    const staff = await server.client();
    assert.equal((await staff.ok("resume", { code: made2.data.roomCode, token: key })).role, "host");
    const phone = await server.client();
    assert.equal((await phone.ok("joinRoom", { code: made2.data.roomCode, role: "player", name: "Cy" })).role, "player");
    await cmd("end", code);
    await cmd("end", made2.data.roomCode);
  });

  test("host_link takes over (the old host becomes a co-host); cohost_link is single use; remove_cohost", async () => {
    const { code, host, players } = await room(server, ["Ann", "Bo", "Cy"]);
    const link = await cmd("host_link", code);
    assert.equal(link.ok, true);
    const key = new URL(link.data.url, "http://x").searchParams.get("host");
    assert.equal((await host.waitFor((s) => s.you.role === "cohost", "co-host now")).you.role, "cohost");
    const staff = await server.client();
    assert.equal((await staff.ok("resume", { code, token: key })).role, "host");
    const link2 = await cmd("host_link", code);
    assert.notEqual(new URL(link2.data.url, "http://x").searchParams.get("host"), key, "a new key each time");
    assert.equal((await staff.emit("resume", { code, token: key })).ok, false, "the old key stops working");

    const inv = await cmd("cohost_link", code, { minutes: 5 });
    assert.equal(inv.ok, true);
    assert.ok(Date.parse(inv.data.expiresAt) > Date.now());
    const invite = new URL(inv.data.url, "http://x").searchParams.get("cohost");
    const ann = players[0];
    const promoted = await ann.ok("joinRoom", { code, role: "player", name: "Ann", token: ann.token, cohost: invite });
    assert.equal(promoted.role, "cohost");
    const other = await server.client();
    assert.match((await other.emit("joinRoom", { code, role: "player", name: "Eve", cohost: invite })).error, /already been used/);

    // A co-host runs the game (and still writes) but can't close the room or remove anyone.
    await ann.ok("start");
    const v = await ann.waitFor((s) => s.phase === "write" && s.you.tasks, "the co-host writes");
    assert.equal(v.you.tasks.length, 2);
    assert.equal((await ann.emit("closeRoom")).ok, false);
    assert.equal((await ann.emit("kick", players[1].id)).ok, false);
    assert.equal((await cmd("remove_cohost", code, { memberId: promoted.memberId })).ok, true);
    assert.equal((await ann.waitFor((s) => s.you.role === "player", "player again")).you.role, "player");
    assert.equal((await cmd("remove_cohost", code, { memberId: promoted.memberId })).ok, false);
    await cmd("end", code);
  });

  test("failed joins are limited per guest (the gateway's client IP), not per gateway", async () => {
    const failJoins = async (ip, n) => {
      const s = io(server.url, { transports: ["websocket"], forceNew: true, reconnection: false, extraHeaders: { "x-bargames-via": "1", "x-bargames-client-ip": ip } });
      await new Promise((r, j) => (s.once("connect", r), s.once("connect_error", j)));
      let last;
      for (let i = 0; i < n; i++) last = await new Promise((r) => s.emit("joinRoom", { code: "QQQQ", role: "player", name: "x" }, r));
      s.close();
      return last.error;
    };
    assert.match(await failJoins("192.168.1.50", 21), /Too many attempts/);
    assert.match(await failJoins("192.168.1.51", 1), /no room/, "another guest behind the same gateway still gets in");
  });

  test("players_changed is debounced; host Close room sends room_closed", async () => {
    const { code, host } = await room(server, ["Ann", "Bo"]);
    const ev = await core.waitFor((e) => e.type === "players_changed" && e.roomCode === code, "players_changed", 6000);
    assert.equal(ev.data.players, 2);
    await host.ok("closeRoom");
    const closed = await core.waitFor((e) => e.type === "room_closed" && e.roomCode === code, "closed");
    assert.equal(closed.data.reason, "host");
  });
});
