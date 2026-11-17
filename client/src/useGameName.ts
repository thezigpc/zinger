import { useGameName as kitUseGameName } from "@bargames/gamekit/client";
import { DEFAULT_GAME_NAME } from "@zinger/shared";
import { serverUrl } from "./socket";

/** GAME_NAME on the server; the venue's rename on a box. Sets document.title. */
export const useGameName = (): string => kitUseGameName(serverUrl, DEFAULT_GAME_NAME);
