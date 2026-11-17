import express from "express";
import { adminRouter as kitAdminRouter, bearerToken, createAdminAuth, log } from "@bargames/gamekit/server";
import { parsePack, type AdminOverview, type AdminSettings } from "@zinger/shared";
import { ADMIN_PASSWORD, store } from "../config.js";
import { deletePack, listPacks, savePack } from "../content.js";
import { ADMIN_CLOSE_REASON, listRooms, type Rooms } from "../rooms/registry.js";
import { bg, clientIp, onBox } from "../bargames.js";
import { getAdminSettings, updateAdminSettings } from "./settings.js";

/**
 * The admin password (the kit's admin auth): ADMIN_PASSWORD, or a scrypt hash chosen once
 * on the /admin setup screen (DATA_DIR/admin.json). On a box the venue box's password works
 * too, and only staff the box vouches for may set a separate one.
 */
export const adminAuth = createAdminAuth({
  store,
  envPassword: ADMIN_PASSWORD,
  saltFormat: "bytes",
  // Standalone behind Cloudflare a whole venue shares one IP: no per-IP lockout there.
  failsAllowed: onBox ? undefined : Infinity,
  venuePassword: (password, ip) => bg.checkVenuePassword(password, ip),
  onBox: bg.connected,
});

const signedIn = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (!adminAuth.isValidSession(bearerToken(req))) return void res.status(401).json({ ok: false, error: "Please sign in again." });
  res.set("Cache-Control", "no-store");
  next();
};

/**
 * /api/admin/upload/pack: prompt packs (text, up to 1 MB). Mounted
 * before the kit's router, whose JSON parser stops at 16 KB.
 */
export function uploadRouter(): express.Router {
  const r = express.Router();
  r.post("/pack", signedIn, express.text({ type: () => true, limit: "1mb" }), async (req, res) => {
    try {
      const text = typeof req.body === "string" ? req.body : "";
      const file = String(req.query.file ?? "");
      const { pack, warnings } = await savePack(String(req.query.name ?? ""), parsePack(text, file));
      res.json({ ok: true, pack, warnings });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : "Couldn't read that file." });
    }
  });
  r.use((err: Error & { type?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const tooBig = err.type === "entity.too.large";
    res.status(tooBig ? 413 : 400).json({ ok: false, error: tooBig ? "That file is too big." : "Couldn't read that upload." });
  });
  return r;
}

/** /api/admin/*: the kit's status, setup, login and logout, then rooms, settings and content. */
export function adminRouter(rooms: Rooms): express.Router {
  // Staff signed in to the venue box get in without the password (SDK 0.7.0).
  const r = kitAdminRouter({ auth: adminAuth, clientIp, trusted: (req) => bg.isStaff(req) });

  r.get("/overview", (_req, res) => {
    const body: AdminOverview = { rooms: listRooms(rooms), settings: getAdminSettings(), packs: listPacks(), serverTime: Date.now() };
    res.json(body);
  });

  r.post("/rooms/:code/close", (req, res) => {
    const code = String(req.params.code).toUpperCase();
    const ok = rooms.closeRoom(code, ADMIN_CLOSE_REASON, "admin");
    log.info("admin", "closed room", { code, ok });
    res.status(ok ? 200 : 404).json(ok ? { ok: true } : { ok: false, error: "That room is already gone." });
  });

  r.put("/settings", async (req, res) => {
    try {
      const settings = await updateAdminSettings((req.body ?? {}) as Partial<AdminSettings>);
      rooms.sweepIdle();
      res.json({ ok: true, settings });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : "Couldn't save." });
    }
  });

  r.delete("/packs/:id", async (req, res) => {
    const ok = await deletePack(String(req.params.id));
    res.status(ok ? 200 : 404).json(ok ? { ok: true } : { ok: false, error: "That pack is already gone (the sample pack can't be deleted)." });
  });

  return r;
}
