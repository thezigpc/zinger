// The game's single connection to a Bar Games box (see BARGAMES.md).
//
// Off a box (no BG_CORE_URL / BG_GAME_TOKEN env) every call here is a no-op and the game
// behaves exactly as it does standalone: that's guaranteed by the SDK.

import { wireBarGames } from "@bargames/gamekit/bargames";
import { createBarGames, type CommandResult } from "@bargames/sdk/server";
import type { IncomingMessage } from "node:http";
import { DEFAULT_GAME_NAME } from "@zinger/shared";
import { createVenueRoom, type Rooms } from "./rooms/registry.js";
import { cohostPath, hostPath, type Room } from "./rooms/Room.js";

export const bg = createBarGames({
  gameId: "zinger",
  defaultName: process.env.GAME_NAME || DEFAULT_GAME_NAME,
});

/** True when running on a box. Guards anything box-only. */
export const onBox = bg.connected;

/** Real player IP for rate limits and logs (cf-connecting-ip or the socket off a box). */
export const clientIp = (req: IncomingMessage): string => bg.clientIp(req);

/** Display name: the venue's rename on a box, otherwise GAME_NAME. */
export async function displayName(fallback: string): Promise<string> {
  return onBox ? (await bg.venue()).game.displayName : fallback;
}

/** Same text the host's own "Close room" sends to everyone in the room. */
export const HOST_CLOSE_REASON = "The host ended this room.";

/**
 * Level 3 through the kit's wireBarGames: status, room_created / room_closed /
 * players_changed, "end", create_room, and the hosting commands. Each command runs the
 * same Room method as the host's button, then broadcasts. Refusals carry the game's text.
 */
export function registerBarGames(rooms: Rooms): void {
  const run =
    (fn: (room: Room) => void) =>
    (room: Room): CommandResult => {
      fn(room); // a GameError becomes { ok: false, message } in the kit
      room.broadcast();
      return { ok: true };
    };

  wireBarGames(bg, rooms, {
    createVenueRoom: ({ kind, title, firstJoinerHosts }) => {
      const { room, hostToken } = createVenueRoom(rooms, kind ?? "venue", title, firstJoinerHosts === true);
      room.broadcast();
      return { room, hostUrl: hostPath(room, hostToken) };
    },
    commands: {
      // The host's Start button.
      start: run((room) => {
        if (room.phase !== "lobby") throw new Error(room.phase === "over" ? "The game is over. Send next_round to play again." : "The game has already started.");
        room.start();
      }),
      // The host's Next: end writing now, start voting after the check, reveal now while
      // voting, the next face-off (or round) after a reveal, a new game from the end screen.
      next_round: run((room) => {
        if (room.phase === "lobby") throw new Error("The game hasn't started yet. Send start first.");
        room.next();
      }),
      // The host's Pause / Resume: timers stop; answers and votes still go in.
      pause: run((room) => {
        if (room.paused) throw new Error("The game is already paused.");
        room.pause();
      }),
      resume: run((room) => {
        if (!room.paused) throw new Error("The game isn't paused.");
        room.resume();
      }),
    },
    seats: {
      of: (room) => room.seats,
      hostPath,
      cohostPath,
      onTakeover: (room, previous) => {
        room.takeOver(previous);
        room.broadcast();
      },
      onCohostRemoved: (room, memberId) => {
        room.demoteCohost(memberId);
        room.broadcast();
      },
    },
    // "end" closes the room like the host's Close room (a game in progress ends first, so
    // game_over and the results still go out).
    endReason: HOST_CLOSE_REASON,
    endCause: "host",
  });
}
