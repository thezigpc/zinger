import type { Server, Socket } from "socket.io";
import { log } from "@bargames/gamekit/server";
import { ERRORS, type JoinResult, type RoomView } from "@zinger/shared";
import { clientIp, HOST_CLOSE_REASON } from "../bargames.js";
import { GameError } from "../rooms/errors.js";
import { cohostPath, type Member, type Room } from "../rooms/Room.js";
import type { Rooms } from "../rooms/registry.js";

interface SocketData {
  code?: string;
  memberId?: string;
  lastEvent?: string;
}
type AckFn = (res: { ok: boolean; [k: string]: unknown }) => void;
interface ServerToClient {
  state: (view: RoomView) => void;
  closed: (p: { reason: string }) => void;
  notice: (p: { message: string }) => void;
}
export type IO = Server<Record<string, (...args: never[]) => void>, ServerToClient, object, SocketData>;
type S = Socket<Record<string, (...args: never[]) => void>, ServerToClient, object, SocketData>;

// Failed join/resume attempts per IP: the room code is the only gate on the join URL, so
// guessing codes must not be free.
const JOIN_WINDOW_MS = 60_000;
const JOIN_FAILS_ALLOWED = 20;
const joinFails = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (joinFails.get(ip) ?? []).filter((t) => now - t < JOIN_WINDOW_MS);
  joinFails.set(ip, recent);
  return recent.length >= JOIN_FAILS_ALLOWED;
}
function noteJoinFail(ip: string): void {
  const list = joinFails.get(ip) ?? [];
  list.push(Date.now());
  joinFails.set(ip, list);
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of joinFails) if (list.every((t) => now - t >= JOIN_WINDOW_MS)) joinFails.delete(ip);
}, JOIN_WINDOW_MS).unref();

export function registerSocketHandlers(io: IO, rooms: Rooms): void {
  io.on("connection", (socket: S) => {
    // On a box: the gateway's x-bargames-client-ip; behind Cloudflare: cf-connecting-ip.
    const ip = clientIp(socket.request);
    socket.onAny((event: string) => {
      socket.data.lastEvent = event;
    });

    const fail = (ack: AckFn | undefined, err: unknown) => {
      if (!(err instanceof GameError)) log.error("socket", "handler threw", { event: socket.data.lastEvent, err: String(err) });
      log.warn("socket", "rejected", { event: socket.data.lastEvent, code: socket.data.code, error: err instanceof GameError ? err.code : "INTERNAL" });
      if (typeof ack === "function") ack({ ok: false, error: err instanceof GameError ? err.message : ERRORS.BAD_REQUEST });
    };

    const unbind = () => {
      const { code, memberId } = socket.data;
      socket.data.code = undefined;
      socket.data.memberId = undefined;
      if (code && memberId) {
        const room = rooms.get(code);
        if (room) {
          room.detachSocket(memberId, socket.id);
          // One fewer to wait for: everyone else may be in now.
          room.checkAllIn();
          room.broadcast();
        }
      }
    };

    const bind = (room: Room, member: Member): JoinResult => {
      if (socket.data.code !== room.code || socket.data.memberId !== member.id) unbind();
      room.attachSocket(member, socket.id);
      // Any attach to the host seat closes the box's "first joiner hosts" offer.
      room.noteAttached(member);
      socket.data.code = room.code;
      socket.data.memberId = member.id;
      return { code: room.code, token: member.token, memberId: member.id, role: member.role, name: member.name };
    };

    const handle = (event: string, h: (...args: unknown[]) => void) => (socket.on as unknown as (e: string, fn: (...a: unknown[]) => void) => void)(event, h);

    /** A room-scoped intent, then a broadcast and an ack. */
    function on<A>(event: string, fn: (room: Room, memberId: string, arg: A) => object | void) {
      handle(event, (...args: unknown[]) => {
        const ack = args[args.length - 1] as AckFn;
        const arg = (args.length > 1 ? args[0] : undefined) as A;
        try {
          const { code, memberId } = socket.data;
          const room = code ? rooms.get(code) : undefined;
          if (!room || !memberId || !room.members.has(memberId)) throw new GameError("NOT_IN_ROOM");
          const result = fn(room, memberId, arg) ?? {};
          room.broadcast();
          if (typeof ack === "function") ack({ ok: true, ...result });
        } catch (err) {
          fail(ack, err);
        }
      });
    }

    const findRoom = (rawCode: unknown): Room => {
      if (rateLimited(ip)) throw new GameError("RATE_LIMITED");
      const room = rooms.get(String(rawCode ?? ""));
      if (!room) {
        noteJoinFail(ip);
        throw new GameError("ROOM_NOT_FOUND");
      }
      return room;
    };

    handle("createRoom", (req: unknown, ack: unknown) => {
      try {
        const r = (req ?? {}) as { name?: unknown; settings?: unknown; plays?: unknown };
        let host: Member | undefined;
        const room = rooms.create("patron", (rm) => {
          if (r.settings) rm.updateSettings(r.settings); // this device's saved defaults
          // "Host and play" (a phone) or "Host on this screen" (a TV: it runs, it doesn't play).
          host = rm.addHost(String(r.name ?? ""), r.plays !== false);
        });
        const result = bind(room, host!);
        (ack as AckFn)({ ok: true, ...result });
        room.broadcast();
      } catch (err) {
        fail(ack as AckFn, err);
      }
    });

    handle("joinRoom", (req: unknown, ack: unknown) => {
      try {
        const r = (req ?? {}) as { code?: unknown; role?: unknown; name?: unknown; token?: unknown; cohost?: unknown };
        const room = findRoom(r.code);
        if (r.role !== "player" && r.role !== "table") throw new GameError("BAD_REQUEST");
        // A known token means "same seat again", never a second seat.
        const existing = room.seatFor(r.token);
        let member: Member;
        if (r.cohost !== undefined) {
          if (r.role !== "player" || !room.seats.redeem(r.cohost)) throw new GameError("BAD_INVITE");
          member = room.seatCohost(existing, r.name);
        } else if (existing && (r.role === "table") === (existing.role === "table")) {
          member = existing;
        } else {
          // A box room nobody hosts yet ("first joiner hosts"): the first phone takes the host seat.
          member = r.role === "player" && room.seats.offerOpen ? room.claimHostSeat(r.name) : room.addMember(r.role, r.name);
        }
        const result = bind(room, member);
        log.info("room", existing === member ? "rejoined" : "joined", { code: room.code, role: member.role });
        (ack as AckFn)({ ok: true, ...result });
        room.broadcast();
      } catch (err) {
        fail(ack as AckFn, err);
      }
    });

    // Sent by the client on EVERY socket connect: socket.io reconnects with a brand-new
    // server-side socket that has no room binding.
    handle("resume", (req: unknown, ack: unknown) => {
      try {
        const r = (req ?? {}) as { code?: unknown; token?: unknown };
        const room = findRoom(r.code);
        const member = room.seatFor(r.token);
        if (!member) {
          noteJoinFail(ip);
          throw new GameError("BAD_TOKEN");
        }
        const result = bind(room, member);
        (ack as AckFn)({ ok: true, ...result });
        room.broadcast();
      } catch (err) {
        fail(ack as AckFn, err);
      }
    });

    handle("leaveRoom", (ack: unknown) => {
      const { code, memberId } = socket.data;
      const room = code ? rooms.get(code) : undefined;
      socket.data.code = undefined;
      socket.data.memberId = undefined;
      if (room && memberId) {
        if (memberId === room.hostId) rooms.closeRoom(room.code, HOST_CLOSE_REASON, "host");
        else {
          room.detachSocket(memberId, socket.id);
          room.removeMember(memberId, "You left the room.");
          room.broadcast();
        }
      }
      if (typeof ack === "function") (ack as AckFn)({ ok: true });
    });

    handle("closeRoom", (ack: unknown) => {
      try {
        const { code, memberId } = socket.data;
        const room = code ? rooms.get(code) : undefined;
        if (!room || !memberId) throw new GameError("NOT_IN_ROOM");
        room.requireHost(memberId);
        rooms.closeRoom(room.code, HOST_CLOSE_REASON, "host");
        (ack as AckFn)({ ok: true });
      } catch (err) {
        fail(ack as AckFn, err);
      }
    });

    // ------------------------------------------------- host and co-hosts
    const runner = (event: string, fn: (room: Room) => void) =>
      on(event, (room, id) => {
        room.requireRunner(id);
        fn(room);
      });
    runner("start", (room) => room.start());
    runner("next", (room) => room.next());
    runner("skip", (room) => room.skip());
    runner("endGame", (room) => room.endGame());
    runner("pause", (room) => room.pause());
    runner("resume", (room) => room.resume());
    on("updateSettings", (room, id, patch) => {
      room.requireRunner(id);
      room.updateSettings(patch);
    });
    on<{ id?: unknown; hidden?: unknown }>("hide", (room, id, req) => {
      room.requireRunner(id);
      room.hideAnswer(req?.id, req?.hidden);
    });
    on<boolean>("setPlaying", (room, id, playing) => {
      room.requireRunner(id);
      room.setPlaying(id, playing);
    });
    // The host only: co-host invites, removing co-hosts and players.
    on("cohostInvite", (room, id) => {
      room.requireHost(id);
      const inv = room.seats.invite();
      return { path: cohostPath(room, inv.token), expiresAt: inv.expiresAt };
    });
    on<string>("removeCohost", (room, id, target) => {
      room.requireHost(id);
      if (!room.seats.isCohost(String(target))) throw new GameError("BAD_REQUEST");
      room.demoteCohost(String(target));
    });
    on<string>("kick", (room, id, target) => {
      room.requireHost(id);
      const t = room.members.get(String(target));
      if (!t || t.id === room.hostId || t.role === "table") throw new GameError("BAD_REQUEST");
      room.removeMember(t.id, "The host removed you from the room.");
    });

    // ------------------------------------------------------- everyone
    on<{ id?: unknown; text?: unknown }>("answer", (room, id, req) => {
      room.submitAnswer(id, req?.id, req?.text);
    });
    on<number>("vote", (room, id, choice) => {
      room.vote(id, choice);
    });
    on<Record<string, number>>("finalVote", (room, id, spread) => {
      room.finalVote(id, spread);
    });
    // Drafts while typing: kept on the server (a dropped phone's answer isn't lost), no broadcast.
    handle("draft", (req: unknown) => {
      const { code, memberId } = socket.data;
      const room = code ? rooms.get(code) : undefined;
      const r = (req ?? {}) as { id?: unknown; text?: unknown };
      if (room && memberId && room.members.has(memberId)) room.saveDraft(memberId, r.id, r.text);
    });

    socket.on("disconnect", () => unbind());
  });
}
