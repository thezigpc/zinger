// Test harness: every spec file gets its own throwaway server on its own port.
// Specs talk to it over real sockets, exactly like the client does.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { io } from "socket.io-client";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

export async function startServer(env = {}) {
  const port = await freePort();
  // Throwaway data dir per server: admin password/settings never leak between specs.
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "zinger-test-"));
  const proc = spawn(process.execPath, [path.join(root, "server/dist/index.js")], {
    env: { ...process.env, PORT: String(port), LOG_LEVEL: "warn", CLIENT_DIST_PATH: path.join(root, "nonexistent"), DATA_DIR: dataDir, ADMIN_PASSWORD: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  proc.stdout.on("data", (d) => (output += d));
  proc.stderr.on("data", (d) => (output += d));
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const clients = [];
  return {
    url,
    dataDir,
    proc,
    port,
    get output() {
      return output;
    },
    async client() {
      const c = await connect(url);
      clients.push(c);
      return c;
    },
    async stop() {
      for (const c of clients) c.socket.close();
      proc.kill();
      await new Promise((r) => proc.once("exit", r));
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** A socket wrapper that remembers the latest state and lets specs await conditions. */
export async function connect(url) {
  const socket = io(url, { transports: ["websocket"], reconnection: false, forceNew: true });
  const c = {
    socket,
    state: null,
    closedReason: null,
    waiters: [],
    emit(event, ...args) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`ack timeout: ${event}`)), 5000);
        socket.emit(event, ...args, (res) => {
          clearTimeout(t);
          resolve(res);
        });
      });
    },
    /** Emits and asserts ok, returning the ack payload. */
    async ok(event, ...args) {
      const res = await c.emit(event, ...args);
      if (!res?.ok) throw new Error(`${event} failed: ${res?.error}`);
      return res;
    },
    waitFor(pred, label = "condition", ms = 5000) {
      if (c.state && pred(c.state)) return Promise.resolve(c.state);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        c.waiters.push(w);
        setTimeout(() => {
          c.waiters = c.waiters.filter((x) => x !== w);
          reject(new Error(`timed out waiting for ${label}; last state: ${JSON.stringify(c.state)?.slice(0, 500)}`));
        }, ms);
      });
    },
  };
  socket.on("state", (s) => {
    c.state = s;
    for (const w of [...c.waiters]) {
      if (w.pred(s)) {
        c.waiters = c.waiters.filter((x) => x !== w);
        w.resolve(s);
      }
    }
  });
  socket.on("closed", ({ reason }) => (c.closedReason = reason));
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  return c;
}

/** Host + N players in one room. */
export async function setupRoom(server, playerNames = ["Ann"]) {
  const host = await server.client();
  const created = await host.ok("createRoom", { name: "Host" });
  const players = [];
  for (const name of playerNames) {
    const p = await server.client();
    const joined = await p.ok("joinRoom", { code: created.code, role: "player", name });
    p.token = joined.token;
    players.push(p);
  }
  return { code: created.code, host, players };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A fake Bar Games box core: venue context, records every event and result. */
export async function fakeCore(token) {
  const http = await import("node:http");
  const events = [];
  const results = [];
  const passwordChecks = [];
  const waiters = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      if (req.headers.authorization !== `Bearer ${token}`) return void res.writeHead(401).end();
      const json = (v) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(v));
      };
      if (req.url === "/internal/events") {
        const e = JSON.parse(body);
        events.push(e);
        for (const w of [...waiters]) if (w.pred(e)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(e));
        return void res.writeHead(204).end();
      }
      if (req.url === "/internal/results") {
        results.push(JSON.parse(body));
        return void res.writeHead(204).end();
      }
      if (req.url === "/internal/venue-password") {
        const b = JSON.parse(body);
        passwordChecks.push(b);
        return json({ ok: b.password === "box-password" });
      }
      if (req.url === "/internal/venue") {
        const theme = { colors: { background: "#0b2a2a", surface: "#12403f", text: "#f2fffd", primary: "#ff4fa3", accent: "#ffd23f" } };
        return json({ protocol: 1, venue: { name: "Test Bar", theme }, game: { id: "zinger", displayName: "Zinger at Test Bar", theme }, standalone: false, generatedAt: new Date().toISOString() });
      }
      res.writeHead(404).end();
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${srv.address().port}`,
    events,
    results,
    passwordChecks,
    of: (type, code) => events.filter((e) => e.type === type && (!code || e.roomCode === code)),
    waitFor(pred, label, ms = 5000) {
      const hit = events.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error(`timed out waiting for ${label}; events: ${events.map((e) => e.type).join(",")}`));
        }, ms);
      });
    },
    close: () => new Promise((r) => srv.close(r)),
  };
}
