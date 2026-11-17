// A whole game over real sockets: prompts to exactly two writers, writing, face-offs,
// scoring (votes, Zinger, audience bonus), stand-ins, the final round, the end.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { FINAL_VOTES } from "@zinger/shared";
import { startServer, sleep } from "../harness.mjs";
import { allSee, room, writeAll } from "../game.mjs";

let server;
before(async () => {
  server = await startServer({ ALL_IN_GRACE_MS: "50" });
});
after(() => server.stop());

describe("prompts go to exactly two writers", () => {
  for (const n of [3, 4, 7, 12]) {
    test(`${n} writers: n prompts, two each, never the same writer twice on one prompt`, async () => {
      const names = Array.from({ length: n }, (_, i) => `W${i + 1}`);
      const { host, players } = await room(server, names, { settings: { maxWriters: Math.min(n, 10) } });
      if (n > 10) {
        // The default writer limit is 10: the rest are audience.
        const s = await host.ok("start");
        assert.ok(s);
        const v = await host.waitFor((x) => x.phase === "write", "writing");
        assert.equal(v.people.filter((p) => p.writer).length, 10);
        assert.equal(v.audienceCount, n - 10);
        await host.ok("closeRoom");
        return;
      }
      await host.ok("start");
      const views = await allSee(players, (s) => s.phase === "write" && s.you.tasks, "tasks");
      const byPrompt = new Map();
      for (const [i, v] of views.entries()) {
        assert.equal(v.you.tasks.length, 2, "two answers each");
        assert.notEqual(v.you.tasks[0].id, v.you.tasks[1].id);
        for (const t of v.you.tasks) byPrompt.set(t.id, [...(byPrompt.get(t.id) ?? []), names[i]]);
      }
      assert.equal(byPrompt.size, n, "one prompt per writer");
      for (const writers of byPrompt.values()) {
        assert.equal(writers.length, 2);
        assert.notEqual(writers[0], writers[1]);
      }
      await host.ok("closeRoom");
    });
  }
});

test("fewer than 3 writers can't start; a host on the TV doesn't write", async () => {
  const { host, players } = await room(server, ["Ann", "Bo"]);
  const res = await host.emit("start");
  assert.equal(res.ok, false);
  assert.match(res.error, /at least 3/);
  await host.ok("setPlaying", true);
  await host.ok("start");
  const s = await players[0].waitFor((v) => v.phase === "write", "writing");
  assert.equal(s.people.filter((p) => p.writer).length, 3);
  await host.ok("closeRoom");
});

test("a full game: writing, face-offs, scores, the final, the end", async () => {
  const { host, players } = await room(server, ["Ann", "Bo", "Cy", "Di"]);
  const [ann] = players;
  await host.ok("start");
  await writeAll(players);
  // Everyone sent: voting starts by itself (no check step: it's off in these rooms).
  let s = await host.waitFor((v) => v.phase === "vote" && v.faceoff, "first face-off");
  assert.equal(s.round, 1);
  assert.equal(s.faceoff.total, 4);
  assert.equal(s.faceoff.answers[0].author, undefined, "no names while voting");

  for (let i = 1; i <= 4; i++) {
    s = await host.waitFor((v) => v.phase === "vote" && v.faceoff?.index === i, `face-off ${i}`);
    const texts = s.faceoff.answers.map((a) => a.text);
    const authors = texts.map((t) => t.split(" ")[0]);
    // The two authors can't vote; the other two vote for answer A.
    for (const p of players) {
      const own = authors.includes(p.name);
      const res = await p.emit("vote", 0);
      assert.equal(res.ok, !own, `${p.name} ${own ? "can't" : "can"} vote on face-off ${i}`);
      if (own) assert.match(res.error, /own face-off/);
    }
    // Everyone who can vote has: it reveals by itself.
    s = await host.waitFor((v) => v.phase === "reveal" && v.faceoff?.index === i, `reveal ${i}`);
    const [a, b] = s.faceoff.answers;
    assert.equal(a.author, authors[0]);
    assert.equal(a.votes, 2);
    assert.equal(b.votes, 0);
    assert.equal(a.zinger, true, "every vote: a Zinger");
    assert.equal(a.points, 2 * 100 + 250);
    assert.equal(b.points, 0);
    await host.ok("next");
  }
  s = await host.waitFor((v) => v.phase === "scores", "round 1 scores");
  assert.equal(s.scores.length, 4);
  assert.equal(
    s.scores.reduce((t, x) => t + x.score, 0),
    4 * 450,
  );
  await host.ok("next");
  s = await host.waitFor((v) => v.phase === "write" && v.round === 2, "round 2");
  // Round 2: skip through it quickly (nobody writes: stand-ins; nobody votes: no points).
  await host.ok("next"); // end writing now
  s = await host.waitFor((v) => v.phase === "vote" && v.round === 2, "round 2 voting");
  assert.ok(s.faceoff.answers.every((a) => a.text.length > 0), "stand-ins fill empty answers");
  for (let i = 0; i < s.faceoff.total; i++) await host.ok("skip");
  s = await host.waitFor((v) => v.phase === "scores" && v.round === 2, "round 2 scores");
  await host.ok("next");

  // The final: one prompt for everyone; FINAL_VOTES to spread, never on your own.
  s = await ann.waitFor((v) => v.phase === "write" && v.round === 3, "final writing");
  assert.equal(s.you.tasks.length, 1);
  assert.equal(s.you.tasks[0].id, "final");
  await writeAll(players, (c) => `${c.name} final`);
  const views = await allSee(players, (v) => v.phase === "vote" && v.final, "final vote");
  const keyOf = (v, name) => v.final.answers.find((x) => x.text === `${name} final`).key;
  const own = views[0].you.finalOwn;
  assert.equal(own, keyOf(views[0], "Ann"));
  let r = await ann.emit("finalVote", { [own]: 1 });
  assert.match(r.error, /your own/);
  r = await ann.emit("finalVote", { [keyOf(views[0], "Bo")]: FINAL_VOTES + 1 });
  assert.match(r.error, /3 votes/);
  // Ann and Cy stack on Bo; Bo and Di stack on Ann (Bo's two writers' votes: 6; Ann's: 6).
  await ann.ok("finalVote", { [keyOf(views[0], "Bo")]: 3 });
  await players[2].ok("finalVote", { [keyOf(views[2], "Bo")]: 2, [keyOf(views[2], "Ann")]: 1 });
  await players[1].ok("finalVote", { [keyOf(views[1], "Ann")]: 3 });
  await players[3].ok("finalVote", { [keyOf(views[3], "Cy")]: 3 });
  s = await host.waitFor((v) => v.phase === "reveal" && v.final?.revealed, "final reveal");
  const byAuthor = Object.fromEntries(s.final.answers.map((x) => [x.author, x]));
  assert.equal(byAuthor.Bo.votes, 5);
  assert.equal(byAuthor.Bo.points, 5 * 300);
  assert.equal(byAuthor.Ann.votes, 4);
  assert.equal(byAuthor.Di.points, 0);
  assert.equal(s.final.answers.at(-1).author, "Bo", "best last");
  await host.ok("next");
  s = await host.waitFor((v) => v.phase === "over", "game over");
  assert.equal(s.winners.length, 1);
  const top = s.scores[0];
  assert.equal(top.place, 1);
  assert.deepEqual(s.winners, [top.id]);
  // Play again resets the scores.
  await host.ok("next");
  s = await host.waitFor((v) => v.phase === "write" && v.round === 1, "a new game");
  assert.ok(s.scores.every((x) => x.score === 0));
  await host.ok("closeRoom");
});

test("audience: past the writer cap, their votes win a bonus and count towards a Zinger", async () => {
  const { host, players } = await room(server, ["Ann", "Bo", "Cy", "Aud1", "Aud2"], { settings: { maxWriters: 3 } });
  await host.ok("start");
  const writers = players.slice(0, 3);
  const audience = players.slice(3);
  const s0 = await audience[0].waitFor((v) => v.phase === "write", "writing");
  assert.equal(s0.you.writer, false);
  assert.equal(s0.you.tasks, undefined);
  assert.equal(s0.audienceCount, 2);
  await writeAll(writers);
  let s = await host.waitFor((v) => v.phase === "vote" && v.faceoff, "voting");
  const authors = s.faceoff.answers.map((a) => a.text.split(" ")[0]);
  const third = writers.find((w) => !authors.includes(w.name));
  await third.ok("vote", 1);
  await audience[0].ok("vote", 1);
  await audience[1].ok("vote", 1);
  s = await host.waitFor((v) => v.phase === "reveal", "reveal");
  const b = s.faceoff.answers[1];
  assert.equal(b.votes, 1, "writer votes");
  assert.equal(b.audience, 2, "audience votes counted apart");
  assert.equal(b.zinger, true);
  assert.equal(b.audienceBonus, true);
  assert.equal(b.points, 100 + 250 + 100);
  await host.ok("closeRoom");
});

test("a lone vote is no Zinger; late votes don't count; skipping scores nothing", async () => {
  const { host, players } = await room(server, ["Ann", "Bo", "Cy"], { settings: { voteSeconds: 8 } });
  await host.ok("start");
  await writeAll(players);
  let s = await host.waitFor((v) => v.phase === "vote" && v.faceoff, "voting");
  const authors = s.faceoff.answers.map((a) => a.text.split(" ")[0]);
  const voter = players.find((p) => !authors.includes(p.name));
  await voter.ok("vote", 0);
  s = await host.waitFor((v) => v.phase === "reveal", "reveal");
  assert.equal(s.faceoff.answers[0].votes, 1);
  assert.equal(s.faceoff.answers[0].zinger, false, "one vote is not a sweep");
  assert.equal(s.faceoff.answers[0].points, 100);
  const late = await voter.emit("vote", 1);
  assert.equal(late.ok, false, "voting has closed");
  await host.ok("next");
  s = await host.waitFor((v) => v.phase === "vote" && v.faceoff.index === 2, "face-off 2");
  const before = s.scores.reduce((t, x) => t + x.score, 0);
  await host.ok("skip");
  s = await host.waitFor((v) => v.phase === "vote" && v.faceoff.index === 3, "face-off 3");
  assert.equal(
    s.scores.reduce((t, x) => t + x.score, 0),
    before,
  );
  await host.ok("closeRoom");
});

test("drafts count when writing closes; empty answers get a stand-in that scores nothing", async () => {
  const { host, players } = await room(server, ["Ann", "Bo", "Cy"]);
  await host.ok("start");
  const [ann, bo] = players;
  const sa = await ann.waitFor((v) => v.phase === "write" && v.you.tasks, "tasks");
  // Ann only types (never sends) her first answer; nobody else writes anything.
  ann.socket.emit("draft", { id: sa.you.tasks[0].id, text: "  a typed   draft  " });
  await sleep(100);
  await host.ok("next"); // end writing now
  let s = await host.waitFor((v) => v.phase === "vote" && v.faceoff, "voting");
  const all = [];
  for (let i = 0; i < 3; i++) {
    s = await host.waitFor((v) => v.phase === "vote" && v.faceoff.index === i + 1, `face-off ${i + 1}`);
    all.push(...s.faceoff.answers.map((a) => a.text));
    // Vote for every answer the voter can: stand-ins still score nothing.
    for (const p of players) await p.emit("vote", 0);
    s = await host.waitFor((v) => v.phase === "reveal", "reveal");
    for (const a of s.faceoff.answers) if (a.standIn) assert.equal(a.points, 0);
    await host.ok("next");
  }
  assert.ok(all.includes("a typed draft"), "the draft was used");
  assert.equal(all.filter((t) => t !== "a typed draft").length, 5);
  s = await host.waitFor((v) => v.phase === "scores", "scores");
  const boLine = s.scores.find((x) => x.name === bo.name);
  assert.equal(boLine.score, 0, "Bo wrote nothing: stand-ins only");
  await host.ok("closeRoom");
});

test("check step: the host hides an answer before it reaches the TV", async () => {
  const { host, players } = await room(server, ["Ann", "Bo", "Cy"], { settings: { check: true } });
  await host.ok("start");
  await writeAll(players, (c, t, i) => (c.name === "Bo" && i === 0 ? "something rude" : `${c.name} answer ${i + 1}`));
  let s = await host.waitFor((v) => v.phase === "check", "checking");
  assert.equal(s.check.length, 6);
  const tv = await server.client();
  await tv.ok("joinRoom", { code: s.code, role: "table" });
  const tvView = await tv.waitFor((v) => v.phase === "check", "tv sees check");
  assert.equal(tvView.check, undefined, "the TV never gets the answers list");
  const ann = await players[0].waitFor((v) => v.phase === "check", "player sees check");
  assert.equal(ann.check, undefined);
  assert.equal((await players[0].emit("hide", { id: s.check[0].id, hidden: true })).ok, false, "players can't hide");
  const rude = s.check.find((c) => c.text === "something rude");
  await host.ok("hide", { id: rude.id, hidden: true });
  await host.ok("next"); // looks good
  const seen = [];
  for (let i = 1; i <= 3; i++) {
    s = await tv.waitFor((v) => v.phase === "vote" && v.faceoff?.index === i, `face-off ${i}`);
    seen.push(...s.faceoff.answers.map((a) => a.text));
    await host.ok("next"); // reveal now
    s = await tv.waitFor((v) => v.phase === "reveal" && v.faceoff?.index === i, `reveal ${i}`);
    for (const a of s.faceoff.answers) if (a.author === "Bo" && a.standIn) assert.equal(a.points, 0);
    await host.ok("next");
  }
  assert.ok(!seen.includes("something rude"), "hidden answer never shown");
  assert.equal(seen.length, 6);
  await host.ok("closeRoom");
});

test("the swear filter masks answers and names; the host can switch it off", async () => {
  const { host, players } = await room(server, ["Ann", "Bo", "Cy"]);
  await host.ok("start");
  await writeAll(players, (c, t, i) => (c.name === "Ann" && i === 0 ? "what the fuck, a class act" : `${c.name} answer ${i + 1}`));
  let s = await host.waitFor((v) => v.phase === "vote", "voting");
  const find = async () => {
    for (let i = 0; i < 3; i++) {
      const v = await host.waitFor((x) => x.phase === "vote" && x.faceoff.index === i + 1, "face-off");
      const hit = v.faceoff.answers.find((a) => a.text.startsWith("what the"));
      if (hit) return hit.text;
      await host.ok("skip");
    }
  };
  assert.equal(await find(), "what the f***, a class act", "masked; 'class' left alone");
  await host.ok("updateSettings", { filter: false });
  s = await host.waitFor((v) => v.settings.filter === false, "filter off");
  assert.ok(s.faceoff.answers.some((a) => a.text === "what the fuck, a class act"));
  await host.ok("closeRoom");
});

test("pause stops the clock; answers still go in", async () => {
  const { host, players } = await room(server, ["Ann", "Bo", "Cy"], { settings: { writeSeconds: 20 } });
  await host.ok("start");
  let s = await host.waitFor((v) => v.phase === "write", "writing");
  assert.ok(s.endsAt);
  await host.ok("pause");
  s = await host.waitFor((v) => v.paused, "paused");
  assert.equal(s.endsAt, undefined);
  assert.ok(s.pausedLeftMs > 0);
  await writeAll(players);
  await sleep(200);
  assert.equal(host.state.phase, "write", "paused: no move on, even with every answer in");
  assert.equal((await players[0].emit("pause")).ok, false, "only runners pause");
  await host.ok("resume");
  await host.waitFor((v) => v.phase === "vote", "voting after resume");
  await host.ok("closeRoom");
});
