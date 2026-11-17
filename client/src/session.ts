import { createSessionStore } from "@bargames/gamekit/client";
import type { Role, RoomSettings } from "@zinger/shared";

export interface StoredSession {
  roomCode: string;
  token: string;
  name: string;
  role: Role;
}

// The kit's session store. Keys start with "zinger_": every game shares the origin on a
// box. The seat is per tab, kept in localStorage so it survives a backgrounded tab.
export const sessions = createSessionStore<StoredSession>("zinger");

export const loadSession = (): StoredSession | null => sessions.load();
export const saveSession = (s: StoredSession): void => sessions.save(s);
export const clearSession = (): void => sessions.clear();

export const lastName = (): string => sessions.pref("last_name");
export const rememberName = (name: string): void => sessions.setPref("last_name", name);

/** This device's last room settings, sent with createRoom. */
export const getSettingsDefault = (): Partial<RoomSettings> | null => sessions.json<Partial<RoomSettings>>("settings_default");
export const setSettingsDefault = (s: Partial<RoomSettings> | null): void => sessions.setJson("settings_default", s);

/** The host showing the TV view on their own screen, per room. */
export const getBigScreen = (code: string): boolean => sessions.pref(`bigscreen:${code}`) === "1";
export const setBigScreen = (code: string, on: boolean): void => sessions.setPref(`bigscreen:${code}`, on ? "1" : null);

/** Answers being typed, per room and prompt (also saved on the server as drafts). */
export const getDraft = (code: string, id: string): string => sessions.pref(`draft:${code}:${id}`);
export const setDraft = (code: string, id: string, text: string): void => sessions.setPref(`draft:${code}:${id}`, text || null);
