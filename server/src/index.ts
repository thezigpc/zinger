import { createServer } from "http";
import { existsSync } from "fs";
import express from "express";
import { Server } from "socket.io";
import { DEFAULT_GAME_NAME } from "@zinger/shared";
import { installShutdown, log, serveSpa, SOCKET_SERVER_OPTIONS } from "@bargames/gamekit/server";
import { CLIENT_DIST_PATH, PORT } from "./config.js";
import { initContent } from "./content.js";
import { createRooms } from "./rooms/registry.js";
import { adminAuth, adminRouter, uploadRouter } from "./admin/routes.js";
import { initAdminSettings } from "./admin/settings.js";
import { registerSocketHandlers, type IO } from "./socket/index.js";
import { bg, displayName, registerBarGames } from "./bargames.js";

await initContent();
await initAdminSettings();
await adminAuth.init();

const app = express();
app.disable("x-powered-by");
const httpServer = createServer(app);
const io: IO = new Server(httpServer, { ...SOCKET_SERVER_OPTIONS, maxHttpBufferSize: 64 * 1024 });

const rooms = createRooms({
  sendState: (socketId, view) => io.to(socketId).emit("state", view),
  sendClosed: (socketId, reason) => io.to(socketId).emit("closed", { reason }),
  sendNotice: (socketId, message) => io.to(socketId).emit("notice", { message }),
});

// Bar Games: /__bargames/* (venue.json, theme.css, command, status). Before the SPA
// catch-all, which would otherwise swallow those paths.
app.use(bg.middleware());
registerBarGames(rooms);

app.get("/health", (_req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});
app.use("/api/admin/upload", uploadRouter());
app.use("/api/admin", adminRouter(rooms));
app.get("/api/config", async (_req, res) => {
  res.json({ gameName: await displayName(process.env.GAME_NAME || DEFAULT_GAME_NAME) });
});

if (existsSync(CLIENT_DIST_PATH)) {
  // The built client. Under a path prefix (BG_BASE_PATH on a box, BASE_PATH behind your own
  // proxy) index.html gets <meta name="bargames-base"> and <base href>.
  serveSpa(app, { dist: CLIENT_DIST_PATH, skip: ["/api", "/socket.io", "/__bargames", "/health"] });
} else {
  log.warn("boot", "client build not found; serving API only", { path: CLIENT_DIST_PATH });
}

registerSocketHandlers(io, rooms);

httpServer.listen(PORT, () => {
  log.info("boot", "listening", { port: PORT });
});

installShutdown(rooms, {
  restartReason: "The server is restarting for an update. Please rejoin in a minute.",
  crashReason: "The server hit an unexpected error and had to restart. Please rejoin in a minute.",
  drainMs: 500,
  flush: () => bg.flush(),
  beforeExit: () => void io.close(),
});
