// Socket protocol, views and settings shared by the server and the client.

export const DEFAULT_GAME_NAME = "Zinger";

/** host: runs the room; cohost: runs the game (can't close it or remove anyone); table: the TV. */
export type Role = "host" | "cohost" | "player" | "table";

/**
 *   lobby → write → check? → vote ⇄ reveal (one face-off at a time) → scores → write (round 2) …
 *   … → write (final) → check? → vote → reveal → over
 */
export type Phase = "lobby" | "write" | "check" | "vote" | "reveal" | "scores" | "over";

/** Which prompts a room uses. */
export type Rating = "family" | "spicy" | "both";
export type PromptTag = "family" | "spicy";

export interface Prompt {
  id: string;
  text: string;
  tag: PromptTag;
}

/** Rounds 1 and 2 are face-offs; round 3 is the final (one prompt for everyone). */
export const FINAL_ROUND = 3;
/** Points per vote, by round (round 2 is worth double). */
export const VOTE_POINTS = [0, 100, 200, 300] as const;
/** A clean sweep (every vote, at least ZINGER_MIN_VOTES of them), by round. */
export const ZINGER_BONUS = [0, 250, 500, 750] as const;
export const ZINGER_MIN_VOTES = 2;
/** The answer the audience liked best (a clear winner among audience votes), by round. */
export const AUDIENCE_BONUS = [0, 100, 200, 300] as const;
/** Final round: votes each voter spreads across the answers. */
export const FINAL_VOTES = 3;
export const ANSWER_MAX = 80;
export const NAME_MAX = 20;

export interface RoomSettings {
  /** Writing time (rounds 1 and 2: two answers; the final: one). */
  writeSeconds: number;
  /** Voting time per face-off (the final gets half as long again). */
  voteSeconds: number;
  /** Move on by itself this many seconds after a reveal; 0 = wait for the host. */
  autoNextSeconds: number;
  /** Which prompts: family, spicy or both. */
  rating: Rating;
  /** Mask swear words in answers and names. */
  filter: boolean;
  /** The host checks the answers (and can hide any) before the TV shows them. */
  check: boolean;
  /** Writers per game; everyone past that is audience. Up to the admin's writer limit. */
  maxWriters: number;
  /** Packs the prompts come from (shuffled together). */
  packIds: string[];
}

export const SETTINGS_LIMITS = {
  writeSeconds: { min: 20, max: 240 },
  voteSeconds: { min: 8, max: 90 },
  autoNextSeconds: { min: 0, max: 60 },
  maxWriters: { min: 3, max: 24 },
} as const;

/** The admin's ceiling on writers per game (rooms choose up to this). */
export const WRITER_LIMIT = { min: 3, max: 24, default: 10 } as const;

export const WRITE_CHOICES = [45, 60, 75, 90, 120];
export const VOTE_CHOICES = [12, 15, 20, 30, 45];
export const AUTO_NEXT_CHOICES = [0, 6, 8, 12];
/** How long the host has to check the answers before the face-offs start by themselves. */
export const CHECK_SECONDS = 45;

export const SAMPLE_PACK_ID = "sample";

export const DEFAULT_SETTINGS: RoomSettings = {
  writeSeconds: 75,
  voteSeconds: 20,
  autoNextSeconds: 8,
  rating: "family",
  filter: true,
  check: true,
  maxWriters: WRITER_LIMIT.default,
  packIds: [SAMPLE_PACK_ID],
};

export interface PackInfo {
  id: string;
  name: string;
  family: number;
  spicy: number;
  standIns: number;
  builtIn: boolean;
}

export interface ScoreLine {
  id: string;
  name: string;
  score: number;
  connected: boolean;
  /** Competition ranking (1, 1, 3). */
  place: number;
  /** Points won in the reveal on screen (or the round just finished, on the scores screen). */
  gained?: number;
}

/** Someone in the room as the lobby and the host see them. */
export interface PersonLine {
  id: string;
  name: string;
  connected: boolean;
  /** Writes this game (or will, if the game started now); otherwise audience. */
  writer: boolean;
  /** Writing phase: has sent every answer. */
  done?: boolean;
}

/** One answer in a face-off. Names, votes and points only once revealed. */
export interface FaceoffAnswer {
  text: string;
  /** Revealed: who wrote it. */
  author?: string;
  /** Revealed: the answer was a stand-in (nothing sent, or hidden by the host). Scores nothing. */
  standIn?: boolean;
  votes?: number;
  audience?: number;
  points?: number;
  zinger?: boolean;
  audienceBonus?: boolean;
}

export interface FaceoffView {
  /** 1-based number of this face-off in the round, and how many there are. */
  index: number;
  total: number;
  prompt: string;
  answers: [FaceoffAnswer, FaceoffAnswer];
  revealed: boolean;
}

export interface FinalAnswer {
  /** Opaque per answer (not a member id: that would give the author away). */
  key: string;
  text: string;
  author?: string;
  standIn?: boolean;
  votes?: number;
  audience?: number;
  points?: number;
  zinger?: boolean;
  audienceBonus?: boolean;
}

export interface FinalView {
  prompt: string;
  /** Voting: in a fixed shuffled order. Revealed: fewest points first (the best last). */
  answers: FinalAnswer[];
  revealed: boolean;
}

/** A prompt a writer answers this round. */
export interface WriteTask {
  id: string;
  prompt: string;
  text: string;
  sent: boolean;
}

/** For hosts and co-hosts while checking: every answer, with its author. */
export interface CheckItem {
  id: string;
  prompt: string;
  text: string;
  author: string;
  hidden: boolean;
  standIn: boolean;
}

export interface RoomView {
  code: string;
  title?: string;
  phase: Phase;
  /** 1, 2 or FINAL_ROUND (0 in the lobby). */
  round: number;
  paused: boolean;
  /** The running timer ends at (server ms). Absent while paused. */
  endsAt?: number;
  /** Paused: what was left on the timer. */
  pausedLeftMs?: number;
  /** The full length of the running timer, for a countdown ring. */
  timerMs?: number;
  /** Reveal / scores: when it moves on by itself. */
  nextAt?: number;
  settings: RoomSettings;
  /** The admin's writer limit (the host's writer setting goes up to it). */
  writerLimit: number;
  /** Writers and audience: lobby order, writers first. */
  people: PersonLine[];
  audienceCount: number;
  /** Writers by score. */
  scores: ScoreLine[];
  faceoff?: FaceoffView;
  final?: FinalView;
  /** Writing: answers sent and expected (everyone's). */
  written?: { sent: number; total: number };
  /** Voting: votes in and people who can vote. */
  votes?: { cast: number; voters: number };
  /** Hosts and co-hosts, check phase (and voting, for answers not shown yet). */
  check?: CheckItem[];
  /** Prompts available for this room's rating (lobby, runners). */
  promptsReady?: number;
  packs: PackInfo[];
  hostName?: string;
  cohosts?: { id: string; name: string }[];
  /** The end screen: who won (member ids). */
  winners?: string[];
  you: {
    id: string;
    role: Role;
    name: string;
    /** Takes part (writes or votes). A host seat on a TV doesn't. */
    plays: boolean;
    writer: boolean;
    score: number;
    /** Writing: this player's prompts. */
    tasks?: WriteTask[];
    /** Face-off: this is your face-off (you can't vote on it). */
    yours?: boolean;
    /** Face-off: your vote (0 or 1). */
    vote?: number;
    /** Final: your votes per answer key. */
    finalVotes?: Record<string, number>;
    /** Final: you wrote this answer (key), so it can't take your votes. */
    finalOwn?: string;
    canVote?: boolean;
  };
  serverTime: number;
}

export interface JoinResult {
  code: string;
  token: string;
  memberId: string;
  role: Role;
  name: string;
}

export const ERRORS = {
  BAD_REQUEST: "That request wasn't valid.",
  ROOM_NOT_FOUND: "There's no room with that code.",
  ROOM_FULL: "That room (or the server) is full right now.",
  NOT_IN_ROOM: "You're not in a room. Join one first.",
  NOT_HOST: "Only the host can do that.",
  NAME_REQUIRED: "Enter your name.",
  NAME_TAKEN: "Someone in the room already has that name.",
  BAD_TOKEN: "Your seat in this room has expired. Join again.",
  BAD_INVITE: "That co-host link has already been used or has expired. Ask the host for a new one.",
  RATE_LIMITED: "Too many attempts. Wait a minute and try again.",
  WRONG_PHASE: "That can't be done right now.",
  NOT_ENOUGH_WRITERS: "Zinger needs at least 3 players to write.",
  NO_PROMPTS: "There aren't enough prompts for this many writers. Pick more packs, or allow spicy prompts.",
  NOT_WRITING: "Writing time is over.",
  NOT_YOUR_PROMPT: "That isn't one of your prompts.",
  NOT_VOTING: "Voting has closed.",
  OWN_FACEOFF: "You can't vote on your own face-off.",
  OWN_ANSWER: "You can't vote for your own answer.",
  TOO_MANY_VOTES: `You have ${FINAL_VOTES} votes to spread.`,
  CANT_VOTE: "Only players can vote.",
} as const;

export const ADMIN_SETTINGS_LIMITS = {
  roomIdleMinutes: { min: 5, max: 7 * 24 * 60 },
} as const;

export interface AdminSettings {
  roomIdleMinutes: number;
  /** The most writers a room may have (its host chooses up to this). */
  writerLimit: number;
  /** Defaults for new rooms. */
  roomDefaults: RoomSettings;
}

export interface AdminRoomSummary {
  code: string;
  kind: string;
  phase: Phase;
  round: number;
  players: number;
  writers: number;
  tables: number;
  hostName?: string;
  createdAt: number;
  lastActivityAt: number;
}

export interface AdminOverview {
  rooms: AdminRoomSummary[];
  settings: AdminSettings;
  packs: PackInfo[];
  serverTime: number;
}

// ---------------------------------------------------------------- validation

const clampInt = (v: unknown, min: number, max: number): number | undefined => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
};

/**
 * Cleans a settings patch: unknown keys dropped, bad values dropped (not thrown), so a
 * device or admin default from an older version never breaks room creation. `writerLimit`
 * caps maxWriters (a value above it is lowered to it).
 */
export function sanitizeSettings(raw: unknown, opts: { knownPacks?: (id: string) => boolean; writerLimit?: number } = {}): Partial<RoomSettings> {
  const r = (raw ?? {}) as Record<string, unknown>;
  const out: Partial<RoomSettings> = {};
  const L = SETTINGS_LIMITS;
  const w = clampInt(r.writeSeconds, L.writeSeconds.min, L.writeSeconds.max);
  if (w !== undefined) out.writeSeconds = w;
  const v = clampInt(r.voteSeconds, L.voteSeconds.min, L.voteSeconds.max);
  if (v !== undefined) out.voteSeconds = v;
  const a = clampInt(r.autoNextSeconds, L.autoNextSeconds.min, L.autoNextSeconds.max);
  if (a !== undefined) out.autoNextSeconds = a;
  const m = clampInt(r.maxWriters, L.maxWriters.min, L.maxWriters.max);
  if (m !== undefined) out.maxWriters = Math.min(m, opts.writerLimit ?? m);
  if (r.rating === "family" || r.rating === "spicy" || r.rating === "both") out.rating = r.rating;
  if (typeof r.filter === "boolean") out.filter = r.filter;
  if (typeof r.check === "boolean") out.check = r.check;
  if (Array.isArray(r.packIds)) {
    out.packIds = [...new Set(r.packIds.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 64))]
      .filter((id) => !opts.knownPacks || opts.knownPacks(id))
      .slice(0, 50);
  }
  return out;
}

export const ratingAllows = (rating: Rating, tag: PromptTag): boolean => rating === "both" || rating === tag;

/** "Round 1", "Round 2 (double points)", "Final round". */
export function roundName(round: number): string {
  if (round >= FINAL_ROUND) return "Final round";
  return round === 2 ? "Round 2" : `Round ${round}`;
}
