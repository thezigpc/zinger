// The room registry (the game kit's RoomRegistry): codes, the room cap, the idle sweep (a
// box's venue room stays open while a TV shows it), close causes, crash containment and a
// debounced players_changed. Room implements the kit's KitRoom.

import { HostSeats, RoomRegistry, type SessionKind } from "@bargames/gamekit/server";
import type { AdminRoomSummary } from "@zinger/shared";
import { getAdminSettings, roomDefaults } from "../admin/settings.js";
import { MAX_ROOMS, ROOM_SWEEP_INTERVAL_MS } from "../config.js";
import { GameError } from "./errors.js";
import { Room, type RoomTransport } from "./Room.js";

export const IDLE_CLOSE_REASON = "This room was closed after a long period of inactivity.";
export const ADMIN_CLOSE_REASON = "An administrator closed this room.";
export const ERROR_CLOSE_REASON = "Something went wrong and this room had to close.";

export type Rooms = RoomRegistry<Room>;

export function createRooms(transport: RoomTransport): Rooms {
  const rooms: Rooms = new RoomRegistry<Room>({
    create: (code, kind, ctx) => {
      const room = new Room(code, transport, kind);
      room.settings = roomDefaults();
      room.onFatalError = () => ctx.close(ERROR_CLOSE_REASON, "error");
      room.onPlayersChanged = () => rooms.notePlayers(room);
      return room;
    },
    maxRooms: MAX_ROOMS,
    idleMinutes: () => getAdminSettings().roomIdleMinutes,
    sweepIntervalMs: ROOM_SWEEP_INTERVAL_MS,
    idleReason: IDLE_CLOSE_REASON,
    errorReason: ERROR_CLOSE_REASON,
    fullError: () => new GameError("ROOM_FULL"),
    // SDK 0.4.0: a "Join" button on the venue's games list (never for private rooms).
    joinPath: (r) => `/join/${r.code}`,
  });
  return rooms;
}

/**
 * Bar Games create_room: a room the box starts for its TVs, with no host phone. Its host
 * seat ("Venue") waits for staff to open the host link; with firstJoinerHosts the first
 * phone to join takes it instead, until anyone attaches to it (the kit's HostSeats).
 */
export function createVenueRoom(rooms: Rooms, kind: SessionKind = "venue", title?: string, firstJoinerHosts = false): { room: Room; hostToken: string } {
  let hostToken = "";
  const room = rooms.create(kind, (r) => {
    r.title = title?.trim().slice(0, 60) || undefined;
    r.addHost("Venue", false);
    r.seats = new HostSeats({ firstJoinerHosts });
    hostToken = r.seats.hostToken;
  });
  return { room, hostToken };
}

export function listRooms(rooms: Rooms): AdminRoomSummary[] {
  return rooms
    .all()
    .map((r) => r.summary())
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}
