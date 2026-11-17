// A player who drops and comes back keeps their seat, answers and score; seats and roles.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { connect, startServer } from "../harness.mjs";
import { room, writeAll } from "../game.mjs";

let server;
before(async () => {
  server = await startServer({ ALL_IN_GRACE_MS: "50" });
});
after(() => server.stop());

test("reconnecting mid-writing keeps the answers sent and the draft typed", async () => {
  const { code, host, players } = await room(server, ["Ann", "Bo", "Cy"]);
  const [ann] = players;
  await host.ok("start");
  const s = await ann.waitFor((v) => v.phase === "write" && v.you.tasks, "tasks");
  const [t1, t2] = s.you.tasks;
  await ann.ok("answer", { id: t1.id, text: "first one" });
  ann.socket.emit("draft", { id: t2.id, text: "half a thought" });
  await new Promise((r) => setTimeout(r, 100));
  ann.socket.close();

  const back = await connect(server.url);
  const r = await back.ok("resume", { code, token: ann.token });
  assert.equal(r.memberId, ann.id);
  const v = await back.waitFor((x) => x.phase === "write" && x.you.tasks, "tasks again");
  assert.deepEqual(
    v.you.tasks.map((t) => [t.text, t.sent]),
    [
      ["first one", true],
      ["half a thought", false],
    ],
  );
  back.socket.close();
  await host.ok("closeRoom");
});

test("reconnecting keeps the score; a new socket can't take someone else's seat", async () => {
  const { code, host, players } = await room(server, ["Ann", "Bo", "Cy"]);
  await host.ok("start");
  await writeAll(players);
  let s = await host.waitFor((v) => v.phase === "vote" && v.faceoff, "voting");
  const authors = s.faceoff.answers.map((a) => a.text.split(" ")[0]);
  const voter = players.find((p) => !authors.includes(p.name));
  await voter.ok("vote", 0);
  s = await host.waitFor((v) => v.phase === "reveal", "reveal");
  const winner = players.find((p) => p.name === authors[0]);
  const scoreBefore = s.scores.find((x) => x.name === winner.name).score;
  assert.ok(scoreBefore > 0);
  winner.socket.close();
  const back = await connect(server.url);
  await back.ok("resume", { code, token: winner.token });
  const v = await back.waitFor((x) => x.phase === "reveal", "back in");
  assert.equal(v.you.score, scoreBefore);
  assert.equal(v.you.writer, true);
  const bad = await (await connect(server.url)).emit("resume", { code, token: "not-a-token" });
  assert.equal(bad.ok, false);
  back.socket.close();
  await host.ok("closeRoom");
});

test("people who join mid-game are audience until the next game", async () => {
  const { code, host, players } = await room(server, ["Ann", "Bo", "Cy"]);
  await host.ok("start");
  const late = await server.client();
  await late.ok("joinRoom", { code, role: "player", name: "Late" });
  const v = await late.waitFor((x) => x.phase === "write", "writing");
  assert.equal(v.you.writer, false);
  assert.equal(v.audienceCount, 1);
  await host.ok("endGame");
  await host.waitFor((x) => x.phase === "over", "over");
  await host.ok("next"); // play again
  const v2 = await late.waitFor((x) => x.phase === "write" && x.round === 1, "new game");
  assert.equal(v2.you.writer, true);
  assert.equal(v2.you.tasks.length, 2);
  void players;
  await host.ok("closeRoom");
});

test("names: required, unique, and the host can remove a player", async () => {
  const { code, host, players } = await room(server, ["Ann", "Bo", "Cy"]);
  const dup = await server.client();
  assert.match((await dup.emit("joinRoom", { code, role: "player", name: "ann" })).error, /already has that name/);
  assert.match((await dup.emit("joinRoom", { code, role: "player", name: "  " })).error, /Enter your name/);
  await host.ok("kick", players[1].id);
  const s = await host.waitFor((v) => v.people.length === 2, "Bo removed");
  assert.ok(!s.people.some((p) => p.name === "Bo"));
  assert.equal((await players[0].emit("kick", players[2].id)).ok, false, "players can't remove anyone");
  await host.ok("closeRoom");
});
