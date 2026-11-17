// Helpers for driving a Zinger game over real sockets.

/**
 * A room with a host and named players. `hostPlays`: the host writes too (Host and play);
 * false is Host on this screen. `settings` go in before anyone joins.
 */
export async function room(server, names, { hostPlays = false, settings = {} } = {}) {
  const host = await server.client();
  const created = await host.ok("createRoom", { name: "Hank", plays: hostPlays });
  await host.ok("updateSettings", { check: false, autoNextSeconds: 0, ...settings });
  const players = [];
  for (const name of names) {
    const p = await server.client();
    const joined = await p.ok("joinRoom", { code: created.code, role: "player", name });
    p.token = joined.token;
    p.id = joined.memberId;
    p.name = name;
    players.push(p);
  }
  await host.waitFor((s) => s.people.length === names.length + (hostPlays ? 1 : 0), "everyone in");
  return { code: created.code, host, players };
}

/** Everyone with tasks answers them all: "<name> <n>" (or `text(name, task)`). */
export async function writeAll(clients, text = (c, t, i) => `${c.name} answer ${i + 1}`) {
  for (const c of clients) {
    const s = await c.waitFor((v) => v.phase === "write" && v.you.tasks, `${c.name} has tasks`);
    for (const [i, t] of s.you.tasks.entries()) await c.ok("answer", { id: t.id, text: text(c, t, i) });
  }
}

/** Waits until every client sees the phase. */
export const allSee = (clients, pred, label) => Promise.all(clients.map((c) => c.waitFor(pred, label)));
