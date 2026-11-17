// One room: the server-authoritative state machine.
//
//   lobby ─start─▶ write ─(timer / all sent / host)─▶ check? ─▶ vote ⇄ reveal (each face-off) ─▶ scores ─▶ write (round 2) …
//                                                                                          … ─▶ write (final) ─▶ check? ─▶ vote ─▶ reveal ─▶ over
//
// Rounds 1 and 2: every writer gets two prompts; each prompt goes to exactly two writers
// (a shuffled ring: prompt i → writers i and i+1). The final: one prompt for every writer,
// and every voter spreads FINAL_VOTES votes. Clients send intents and render the view
// they're sent; nothing is decided on a phone.

import {
  ANSWER_MAX,
  AUDIENCE_BONUS,
  CHECK_SECONDS,
  DEFAULT_SETTINGS,
  FINAL_ROUND,
  FINAL_VOTES,
  NAME_MAX,
  VOTE_POINTS,
  ZINGER_BONUS,
  ZINGER_MIN_VOTES,
  ratingAllows,
  roundName,
  sanitizeSettings,
  type AdminRoomSummary,
  type CheckItem,
  type FaceoffAnswer,
  type PersonLine,
  type Phase,
  type Prompt,
  type Role,
  type RoomSettings,
  type RoomView,
  type ScoreLine,
  type WriteTask,
} from "@zinger/shared";
import { HostSeats, cryptoRand, log, newId, newToken, safeTimeout, type CloseCause, type KitRoom, type RoomOverview, type SessionKind } from "@bargames/gamekit/server";
import { bg } from "../bargames.js";
import { ALL_IN_GRACE_MS, MAX_PLAYERS_PER_ROOM, MAX_TABLES_PER_ROOM } from "../config.js";
import { hasPack, listPacks, packPrompts, standInsFor } from "../content.js";
import { writerLimit } from "../admin/settings.js";
import { maskProfanity } from "../profanity.js";
import { GameError } from "./errors.js";

export interface Member {
  id: string;
  token: string;
  role: Role;
  name: string;
  socketIds: Set<string>;
  /** Takes part: writes (if there's a writer seat for them) or votes as audience. */
  plays: boolean;
  score: number;
  /** Points from the reveal on screen. */
  lastGain: number;
  /** Points this round. */
  roundGain: number;
  joinedAt: number;
}

/** How the room talks to sockets: injected so Room has no socket.io dependency. */
export interface RoomTransport {
  sendState(socketId: string, view: RoomView): void;
  sendClosed(socketId: string, reason: string): void;
  sendNotice(socketId: string, message: string): void;
}

/** One writer's answer to one prompt. */
interface Answer {
  authorId: string;
  /** At the time of writing (a removed writer's answer keeps their name). */
  authorName: string;
  /** What they sent (or their last draft, once writing closes). */
  text: string;
  sent: boolean;
  /** Typed but not sent yet: used when writing closes. */
  draft: string;
  /** The stand-in joke, when there was no answer or the host hid it. */
  standIn?: string;
  hidden: boolean;
}

interface Result {
  votes: number;
  audience: number;
  points: number;
  zinger: boolean;
  audienceBonus: boolean;
}

interface Faceoff {
  id: string;
  prompt: Prompt;
  slots: [Answer, Answer];
  /** Voter → 0 or 1. */
  votes: Map<string, 0 | 1>;
  results?: [Result, Result];
}

interface FinalAnswer extends Answer {
  key: string;
  result?: Result;
}

interface Final {
  prompt: Prompt;
  /** In the shuffled order phones and the TV show. */
  answers: FinalAnswer[];
  /** Voter → votes per answer key. */
  votes: Map<string, Record<string, number>>;
  revealed: boolean;
}

/** The host key's link and co-host invites (the box's host_link / cohost_link too). */
export const hostPath = (room: { code: string }, token: string) => `/join/${room.code}?host=${encodeURIComponent(token)}`;
export const cohostPath = (room: { code: string }, token: string) => `/join/${room.code}?cohost=${encodeURIComponent(token)}`;

export const TAKEOVER_NOTICE = "Staff took over hosting. You're a co-host now: you can still run the game.";
export const COHOST_REMOVED_NOTICE = "You're not a co-host any more.";

const cleanName = (raw: unknown) => (typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, NAME_MAX) : "");
export const cleanAnswer = (raw: unknown) => (typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, ANSWER_MAX) : "");

function shuffle<T>(list: T[]): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = cryptoRand(i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** What shows for an answer: the stand-in when it was empty or hidden. */
const shownText = (a: Answer): string => (a.hidden || !a.text ? (a.standIn ?? "") : a.text);
const isStandIn = (a: Answer): boolean => a.hidden || !a.text;

const IN_GAME: Phase[] = ["write", "check", "vote", "reveal", "scores"];

export class Room implements KitRoom {
  readonly members = new Map<string, Member>();
  hostId = "";
  seats = new HostSeats();
  phase: Phase = "lobby";
  /** 1, 2 or FINAL_ROUND; 0 in the lobby. */
  round = 0;
  settings: RoomSettings = { ...DEFAULT_SETTINGS };
  /** This game's writers, in seat order. */
  writerIds: string[] = [];
  faceoffs: Faceoff[] = [];
  /** The face-off on screen. */
  index = 0;
  final?: Final;
  winners: string[] = [];
  paused = false;
  lastActivityAt = Date.now();
  readonly createdAt = Date.now();
  closed = false;
  kind: SessionKind;
  title?: string;

  /** The packs' prompts not used yet, shuffled. */
  private deck: Prompt[] = [];
  /** Prompt ids used in this room (any game), so a replay brings new ones first. */
  private readonly used = new Set<string>();
  private standIns: string[] = [];
  // The one running timer: a phase's countdown, or the move-on after a reveal.
  private mainTimer?: NodeJS.Timeout;
  private mainKind?: "phase" | "next";
  private mainFn?: () => void;
  private mainAt?: number;
  private mainMs?: number;
  private pausedLeft?: number;
  /** Everyone's answers or votes are in: a short beat, then on. */
  private graceTimer?: NodeJS.Timeout;

  onFatalError: (err: unknown) => void = () => {};
  onPlayersChanged: () => void = () => {};

  constructor(
    readonly code: string,
    private readonly transport: RoomTransport,
    kind: SessionKind = "patron",
  ) {
    this.kind = kind;
  }

  private touch() {
    this.lastActivityAt = Date.now();
  }

  // ------------------------------------------------------------- members

  /** The room's host seat. `plays`: a host on a phone writes and votes too; a TV host doesn't. */
  addHost(name: string, plays = true): Member {
    const m = this.newMember("host", cleanName(name) || "Host", plays);
    this.hostId = m.id;
    return m;
  }

  /** The first phone into a "first joiner hosts" room takes the host seat, under its name. */
  claimHostSeat(rawName: unknown): Member {
    const host = this.members.get(this.hostId);
    const name = cleanName(rawName);
    if (!name) throw new GameError("NAME_REQUIRED");
    if (this.nameTaken(name, this.hostId)) throw new GameError("NAME_TAKEN");
    if (!host || this.seats.claimForJoiner() !== "host") throw new GameError("BAD_REQUEST");
    host.name = name;
    host.plays = true;
    host.joinedAt = Date.now();
    this.playersChanged();
    return host;
  }

  /** The seat a token opens: a member's own token, or the host key (the host seat). */
  seatFor(token: unknown): Member | undefined {
    if (typeof token !== "string" || !token) return undefined;
    return this.findByToken(token) ?? (this.seats.isHostToken(token) ? this.members.get(this.hostId) : undefined);
  }

  /** Anyone attached to a seat. For the host seat this closes the first-joiner offer. */
  noteAttached(member: Member): void {
    if (member.role === "host") this.seats.hostAttached(member.id);
  }

  cohosts(): Member[] {
    return [...this.members.values()].filter((m) => m.role === "cohost");
  }

  /** A redeemed co-host invite: a new co-host, or a player already here promoted. */
  seatCohost(existing: Member | undefined, rawName: unknown): Member {
    if (existing && existing.role !== "player") return existing;
    let m = existing;
    if (m) m.role = "cohost";
    else {
      const name = cleanName(rawName);
      if (!name) throw new GameError("NAME_REQUIRED");
      if (this.nameTaken(name)) throw new GameError("NAME_TAKEN");
      if (this.cohosts().length >= 20) throw new GameError("ROOM_FULL");
      m = this.newMember("cohost", name, true);
      this.playersChanged();
    }
    this.seats.addCohost(m.id);
    return m;
  }

  /** Staff took over (host_link): the old host's phone stays on as a co-host. */
  takeOver(previous: string | undefined): void {
    const old = previous ? this.members.get(previous) : undefined;
    if (!old || old.role !== "host") return;
    old.role = "cohost";
    this.hostId = this.newMember("host", "Venue", false).id;
    this.notify(old, TAKEOVER_NOTICE);
  }

  /** A co-host is a player again. */
  demoteCohost(memberId: string): void {
    const m = this.members.get(memberId);
    this.seats.removeCohost(memberId);
    if (!m || m.role !== "cohost") return;
    m.role = "player";
    this.notify(m, COHOST_REMOVED_NOTICE);
  }

  private nameTaken(name: string, except?: string): boolean {
    const n = name.toLowerCase();
    return [...this.members.values()].some((m) => m.id !== except && m.role !== "table" && m.name.toLowerCase() === n);
  }

  private notify(m: Member, message: string): void {
    for (const sid of m.socketIds) this.transport.sendNotice(sid, message);
  }

  addMember(role: "player" | "table", rawName: unknown): Member {
    this.touch();
    if (role === "table") {
      if (this.tables().length >= MAX_TABLES_PER_ROOM) throw new GameError("ROOM_FULL");
      return this.newMember("table", "TV", false);
    }
    const name = cleanName(rawName);
    if (!name) throw new GameError("NAME_REQUIRED");
    if (this.participants().length >= MAX_PLAYERS_PER_ROOM) throw new GameError("ROOM_FULL");
    if (this.nameTaken(name)) throw new GameError("NAME_TAKEN");
    const m = this.newMember("player", name, true);
    this.playersChanged();
    return m;
  }

  private newMember(role: Role, name: string, plays: boolean): Member {
    const m: Member = { id: newId(), token: newToken(), role, name, socketIds: new Set(), plays, score: 0, lastGain: 0, roundGain: 0, joinedAt: Date.now() };
    this.members.set(m.id, m);
    return m;
  }

  findByToken(token: string): Member | undefined {
    for (const m of this.members.values()) if (m.token === token) return m;
    return undefined;
  }

  attachSocket(member: Member, socketId: string): void {
    member.socketIds.add(socketId);
  }

  detachSocket(memberId: string, socketId: string): void {
    this.members.get(memberId)?.socketIds.delete(socketId);
  }

  removeMember(memberId: string, reason: string): void {
    const m = this.members.get(memberId);
    if (!m) return;
    for (const sid of m.socketIds) this.transport.sendClosed(sid, reason);
    this.members.delete(memberId);
    this.seats.removeCohost(memberId);
    for (const f of this.faceoffs) f.votes.delete(memberId);
    this.final?.votes.delete(memberId);
    if (m.plays) this.playersChanged();
    this.checkAllIn();
  }

  /** A host or co-host decides whether they play (lobby only: writers are picked at the start). */
  setPlaying(memberId: string, on: unknown): void {
    if (this.phase !== "lobby" && this.phase !== "over") throw new GameError("WRONG_PHASE");
    const m = this.members.get(memberId);
    if (!m || m.role === "table" || typeof on !== "boolean") throw new GameError("BAD_REQUEST");
    m.plays = on;
    this.playersChanged();
  }

  /** Everyone who takes part: writers and audience (not TVs, not a host seat that only runs it). */
  participants(): Member[] {
    return [...this.members.values()].filter((m) => m.role !== "table" && m.plays);
  }

  tables(): Member[] {
    return [...this.members.values()].filter((m) => m.role === "table");
  }

  writers(): Member[] {
    return this.writerIds.map((id) => this.members.get(id)).filter((m): m is Member => !!m);
  }

  isWriter(id: string): boolean {
    return this.writerIds.includes(id);
  }

  private playersChanged(): void {
    if (!this.closed) this.onPlayersChanged();
  }

  /** Host or co-host: runs the game and its settings. */
  requireRunner(memberId: string): void {
    if (!this.seats.canRun(memberId)) throw new GameError("NOT_HOST");
  }

  /** The host only: closing the room, removing people, co-host invites. */
  requireHost(memberId: string): void {
    if (this.seats.roleOf(memberId) !== "host") throw new GameError("NOT_HOST");
  }

  /** The names everyone sees (masked when the filter is on). */
  nameOf(m: { name: string }): string {
    return this.settings.filter ? maskProfanity(m.name) : m.name;
  }

  private textOf(a: Answer): string {
    const t = shownText(a);
    return this.settings.filter ? maskProfanity(t) : t;
  }

  // ------------------------------------------------------------ the KitRoom

  playerCount(): number {
    return this.participants().length;
  }

  tableCount(): number {
    return this.tables().filter((m) => m.socketIds.size > 0).length;
  }

  hostConnected(): boolean {
    return (this.members.get(this.hostId)?.socketIds.size ?? 0) > 0;
  }

  hostName(): string | undefined {
    const h = this.members.get(this.hostId);
    return h ? this.nameOf(h) : undefined;
  }

  maxPlayers(): number {
    return MAX_PLAYERS_PER_ROOM;
  }

  overviewExtra(): Partial<RoomOverview> {
    const what =
      this.phase === "lobby"
        ? "Lobby"
        : this.phase === "over"
          ? "Game over"
          : this.round < FINAL_ROUND && (this.phase === "vote" || this.phase === "reveal")
            ? `${roundName(this.round)}, face-off ${this.index + 1} of ${this.faceoffs.length}`
            : `${roundName(this.round)}: ${this.phase === "write" ? "writing" : this.phase === "check" ? "checking answers" : this.phase === "scores" ? "scores" : this.phase === "vote" ? "voting" : "reveal"}`;
    return { title: `${this.title ? `${this.title} · ` : ""}${what}${this.paused ? " (paused)" : ""}`.slice(0, 120) };
  }

  summary(): AdminRoomSummary {
    return {
      code: this.code,
      kind: this.kind,
      phase: this.phase,
      round: this.round,
      players: this.playerCount(),
      writers: this.writerIds.length,
      tables: this.tableCount(),
      hostName: this.hostName(),
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
    };
  }

  // ------------------------------------------------------------ settings

  updateSettings(patch: unknown): void {
    this.touch();
    const clean = sanitizeSettings(patch, { knownPacks: hasPack, writerLimit: writerLimit() });
    this.settings = { ...this.settings, ...clean };
    if (!this.settings.packIds.length) this.settings.packIds = [...DEFAULT_SETTINGS.packIds];
    this.settings.maxWriters = Math.min(this.settings.maxWriters, writerLimit());
    // Auto-next switched off while a reveal waits: stop the pending move on.
    if (clean.autoNextSeconds === 0 && this.mainKind === "next") this.clearMain();
  }

  /** The chosen packs' prompts this room's rating allows (unique). */
  private promptPool(): Prompt[] {
    const seen = new Set<string>();
    const out: Prompt[] = [];
    for (const id of this.settings.packIds) {
      for (const p of packPrompts(id)) {
        if (!seen.has(p.id) && ratingAllows(this.settings.rating, p.tag)) {
          seen.add(p.id);
          out.push(p);
        }
      }
    }
    return out;
  }

  private takePrompts(n: number): Prompt[] {
    if (this.deck.length < n) {
      // Out of fresh prompts: deal the used ones again rather than stop the game.
      const inDeck = new Set(this.deck.map((p) => p.id));
      this.deck.push(...shuffle(this.promptPool().filter((p) => !inDeck.has(p.id))));
    }
    const out = this.deck.splice(0, n);
    for (const p of out) this.used.add(p.id);
    return out;
  }

  private nextStandIn(): string {
    if (!this.standIns.length) this.standIns = shuffle(standInsFor(this.settings.packIds));
    return this.standIns.shift() ?? "…";
  }

  // ------------------------------------------------------------ timers

  private safe(label: string, ms: number, fn: () => void): NodeJS.Timeout {
    return safeTimeout(
      label,
      ms,
      () => {
        if (this.closed) return;
        fn();
        this.broadcast();
      },
      this.onFatalError,
    );
  }

  private clearMain(): void {
    clearTimeout(this.mainTimer);
    this.mainTimer = this.mainKind = this.mainFn = this.mainAt = this.mainMs = this.pausedLeft = undefined;
  }

  private clearGrace(): void {
    clearTimeout(this.graceTimer);
    this.graceTimer = undefined;
  }

  private clearTimers(): void {
    this.clearMain();
    this.clearGrace();
  }

  /** The phase's countdown (or the move on after a reveal). Paused: it waits with its full length. */
  private schedule(kind: "phase" | "next", ms: number, fn: () => void): void {
    this.clearTimers();
    this.mainKind = kind;
    this.mainFn = fn;
    this.mainMs = ms;
    if (this.paused) {
      this.pausedLeft = ms;
      return;
    }
    this.mainAt = Date.now() + ms;
    this.mainTimer = this.safe(kind, ms, () => {
      this.mainTimer = this.mainKind = this.mainFn = this.mainAt = this.mainMs = undefined;
      fn();
    });
  }

  private scheduleNext(ms: number, fn: () => void): void {
    if (ms > 0) this.schedule("next", ms, fn);
    else this.clearTimers();
  }

  pause(): void {
    if (!IN_GAME.includes(this.phase)) throw new GameError("WRONG_PHASE");
    this.touch();
    if (this.paused) return;
    this.paused = true;
    this.clearGrace();
    if (this.mainTimer && this.mainAt !== undefined) {
      clearTimeout(this.mainTimer);
      this.mainTimer = undefined;
      this.pausedLeft = Math.max(1000, this.mainAt - Date.now());
      this.mainAt = undefined;
    }
  }

  resume(): void {
    if (!IN_GAME.includes(this.phase)) throw new GameError("WRONG_PHASE");
    this.touch();
    if (!this.paused) return;
    this.paused = false;
    const fn = this.mainFn;
    const kind = this.mainKind;
    const left = this.pausedLeft;
    if (fn && kind && left !== undefined) {
      const total = this.mainMs;
      this.schedule(kind, left, fn);
      this.mainMs = total; // the ring keeps its full length
    }
    this.checkAllIn();
  }

  private emit(type: "round_started" | "round_ended" | "winner" | "game_over" | "x-zinger-sweep", data: Record<string, unknown>): void {
    bg.emit({ type, roomCode: this.code, sessionKind: this.kind, data });
  }

  // ------------------------------------------------------------ the game

  /** Writers for a new game: connected players first, in the order they joined, up to the cap. */
  private pickWriters(): Member[] {
    const all = this.participants().sort((a, b) => a.joinedAt - b.joinedAt);
    const on = all.filter((m) => m.socketIds.size > 0);
    return on.slice(0, Math.min(this.settings.maxWriters, writerLimit()));
  }

  /** Start a game (from the lobby) or a new one (from the end screen): scores reset. */
  start(): void {
    if (this.phase !== "lobby" && this.phase !== "over") throw new GameError("WRONG_PHASE");
    const writers = this.pickWriters();
    if (writers.length < 3) throw new GameError("NOT_ENOUGH_WRITERS");
    const pool = this.promptPool();
    if (pool.length < writers.length) throw new GameError("NO_PROMPTS");
    this.touch();
    this.clearTimers();
    this.paused = false;
    this.writerIds = writers.map((m) => m.id);
    for (const m of this.members.values()) {
      m.score = 0;
      m.lastGain = 0;
      m.roundGain = 0;
    }
    this.winners = [];
    this.final = undefined;
    this.faceoffs = [];
    this.standIns = [];
    this.deck = [...shuffle(pool.filter((p) => !this.used.has(p.id))), ...shuffle(pool.filter((p) => this.used.has(p.id)))];
    log.info("room", "game started", { code: this.code, writers: writers.length, audience: this.participants().length - writers.length });
    this.startRound(1);
  }

  private newAnswer(m: Member): Answer {
    return { authorId: m.id, authorName: m.name, text: "", sent: false, draft: "", hidden: false };
  }

  private startRound(round: number): void {
    this.round = round;
    this.index = 0;
    for (const m of this.members.values()) {
      m.roundGain = 0;
      m.lastGain = 0;
    }
    const writers = shuffle(this.writers());
    if (round < FINAL_ROUND) {
      const prompts = this.takePrompts(writers.length);
      this.faceoffs = prompts.map((prompt, i) => {
        const pair: [Answer, Answer] = [this.newAnswer(writers[i]!), this.newAnswer(writers[(i + 1) % writers.length]!)];
        if (cryptoRand(2) === 1) pair.reverse();
        return { id: `r${round}f${i + 1}`, prompt, slots: pair, votes: new Map() };
      });
      // Show them in a fresh order (not the ring's, which would hint at who wrote what).
      this.faceoffs = shuffle(this.faceoffs);
      this.final = undefined;
    } else {
      const [prompt] = this.takePrompts(1);
      this.faceoffs = [];
      this.final = { prompt: prompt!, answers: writers.map((m) => ({ ...this.newAnswer(m), key: newId() })), votes: new Map(), revealed: false };
    }
    this.phase = "write";
    this.schedule("phase", this.settings.writeSeconds * 1000, () => this.closeWriting());
    this.emit("round_started", { round, final: round === FINAL_ROUND, writers: writers.length });
  }

  /** Every answer of this round (face-offs, or the final's). */
  private allAnswers(): Answer[] {
    return this.final ? this.final.answers : this.faceoffs.flatMap((f) => f.slots);
  }

  /** This writer's answers this round, by task id. */
  private tasksOf(memberId: string): { id: string; prompt: Prompt; answer: Answer }[] {
    if (this.final) {
      const a = this.final.answers.find((x) => x.authorId === memberId);
      return a ? [{ id: "final", prompt: this.final.prompt, answer: a }] : [];
    }
    const out: { id: string; prompt: Prompt; answer: Answer }[] = [];
    for (const f of this.faceoffs) for (const s of f.slots) if (s.authorId === memberId) out.push({ id: f.id, prompt: f.prompt, answer: s });
    return out;
  }

  /** A writer sends (or changes) an answer while writing is open. */
  submitAnswer(memberId: string, taskId: unknown, raw: unknown): void {
    if (this.phase !== "write") throw new GameError("NOT_WRITING");
    const task = this.tasksOf(memberId).find((t) => t.id === taskId);
    if (!task) throw new GameError("NOT_YOUR_PROMPT");
    const text = cleanAnswer(raw);
    if (!text) throw new GameError("BAD_REQUEST");
    this.touch();
    task.answer.text = text;
    task.answer.draft = text;
    task.answer.sent = true;
    this.checkAllIn();
  }

  /** What a writer has typed so far: kept, so a dropped phone's answer isn't lost. */
  saveDraft(memberId: string, taskId: unknown, raw: unknown): void {
    if (this.phase !== "write") return;
    const task = this.tasksOf(memberId).find((t) => t.id === taskId);
    if (!task || task.answer.sent) return;
    task.answer.draft = cleanAnswer(raw);
  }

  /** Writing closes: drafts count, and an empty answer gets a stand-in. */
  private closeWriting(): void {
    this.clearTimers();
    for (const a of this.allAnswers()) {
      if (!a.sent && a.draft) a.text = a.draft;
      if (!a.text) a.standIn = this.nextStandIn();
    }
    const runnerOn = [...this.members.values()].some((m) => this.seats.canRun(m.id) && m.socketIds.size > 0);
    if (this.settings.check && runnerOn) {
      this.phase = "check";
      this.schedule("phase", CHECK_SECONDS * 1000, () => this.beginVoting());
    } else this.beginVoting();
  }

  /** The host hides an answer (it shows as a stand-in and scores nothing), or shows it again. */
  hideAnswer(itemId: unknown, hidden: unknown): void {
    if (typeof itemId !== "string" || typeof hidden !== "boolean") throw new GameError("BAD_REQUEST");
    const item = this.checkable().find((c) => c.id === itemId);
    if (!item) throw new GameError("WRONG_PHASE");
    this.touch();
    item.answer.hidden = hidden;
    if (hidden && !item.answer.standIn) item.answer.standIn = this.nextStandIn();
  }

  /** Answers the host may still hide: everything while checking; ones not shown yet while voting. */
  private checkable(): { id: string; prompt: Prompt; answer: Answer }[] {
    if (this.phase !== "check" && this.phase !== "vote") return [];
    if (this.final) return this.final.revealed ? [] : this.final.answers.map((a) => ({ id: a.key, prompt: this.final!.prompt, answer: a }));
    const from = this.phase === "check" ? 0 : this.index;
    return this.faceoffs.slice(from).flatMap((f) => f.slots.map((answer, i) => ({ id: `${f.id}:${i}`, prompt: f.prompt, answer })));
  }

  private beginVoting(): void {
    this.clearTimers();
    if (this.final) {
      this.phase = "vote";
      this.schedule("phase", Math.round(this.settings.voteSeconds * 1.5) * 1000, () => this.revealFinal());
    } else {
      this.index = 0;
      this.startFaceoff();
    }
  }

  private startFaceoff(): void {
    const f = this.faceoffs[this.index]!;
    f.votes.clear();
    f.results = undefined;
    this.phase = "vote";
    for (const m of this.members.values()) m.lastGain = 0;
    this.schedule("phase", this.settings.voteSeconds * 1000, () => this.revealFaceoff());
  }

  /** Can this member vote right now? (Not on their own face-off; TVs and non-playing hosts never.) */
  canVote(m: Member): boolean {
    if (this.phase !== "vote" || !m.plays || m.role === "table") return false;
    if (this.final) return true;
    const f = this.faceoffs[this.index];
    return !!f && !f.slots.some((s) => s.authorId === m.id);
  }

  vote(memberId: string, choice: unknown): void {
    if (this.phase !== "vote" || this.final) throw new GameError("NOT_VOTING");
    const m = this.members.get(memberId);
    if (!m || !m.plays || m.role === "table") throw new GameError("CANT_VOTE");
    if (!this.canVote(m)) throw new GameError("OWN_FACEOFF");
    if (choice !== 0 && choice !== 1) throw new GameError("BAD_REQUEST");
    this.touch();
    this.faceoffs[this.index]!.votes.set(memberId, choice);
    this.checkAllIn();
  }

  /** Final round: this voter's whole spread (replaces the last one). */
  finalVote(memberId: string, raw: unknown): void {
    if (this.phase !== "vote" || !this.final) throw new GameError("NOT_VOTING");
    const m = this.members.get(memberId);
    if (!m || !this.canVote(m)) throw new GameError("CANT_VOTE");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new GameError("BAD_REQUEST");
    const own = this.final.answers.find((a) => a.authorId === memberId)?.key;
    const keys = new Set(this.final.answers.map((a) => a.key));
    const spread: Record<string, number> = {};
    let total = 0;
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!keys.has(k) || typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new GameError("BAD_REQUEST");
      if (v === 0) continue;
      if (k === own) throw new GameError("OWN_ANSWER");
      spread[k] = v;
      total += v;
    }
    if (total > FINAL_VOTES) throw new GameError("TOO_MANY_VOTES");
    this.touch();
    this.final.votes.set(memberId, spread);
    this.checkAllIn();
  }

  /** People who can vote now and are connected. */
  private liveVoters(): Member[] {
    return [...this.members.values()].filter((m) => m.socketIds.size > 0 && this.canVote(m));
  }

  /** Everyone connected has answered (or voted): move on after a short beat. */
  checkAllIn(): void {
    this.clearGrace();
    if (this.paused || this.closed) return;
    let done = false;
    if (this.phase === "write") {
      const answers = this.allAnswers();
      done = answers.length > 0 && answers.every((a) => a.sent);
    } else if (this.phase === "vote") {
      const voters = this.liveVoters();
      if (this.final) {
        const fin = this.final;
        const usable = (m: Member) => Math.min(FINAL_VOTES, fin.answers.filter((a) => a.authorId !== m.id).length);
        done = voters.length > 0 && voters.every((m) => Object.values(fin.votes.get(m.id) ?? {}).reduce((s, n) => s + n, 0) >= usable(m));
      } else {
        const f = this.faceoffs[this.index]!;
        done = voters.length > 0 && voters.every((m) => f.votes.has(m.id));
      }
    }
    if (!done) return;
    const phase = this.phase;
    this.graceTimer = this.safe("all-in", ALL_IN_GRACE_MS, () => {
      this.graceTimer = undefined;
      if (this.phase !== phase) return;
      if (phase === "write") this.closeWriting();
      else if (this.final) this.revealFinal();
      else this.revealFaceoff();
    });
  }

  /** A writer's points for one answer. Stand-ins (and hidden answers) score nothing. */
  private score(a: Answer, votes: number, audience: number, zinger: boolean, audienceBonus: boolean): Result {
    const real = !isStandIn(a);
    const r = this.round;
    const points = real ? votes * VOTE_POINTS[r]! + (zinger ? ZINGER_BONUS[r]! : 0) + (audienceBonus ? AUDIENCE_BONUS[r]! : 0) : 0;
    return { votes, audience, points, zinger: zinger && real, audienceBonus: audienceBonus && real };
  }

  private award(a: Answer, points: number): void {
    const m = this.members.get(a.authorId);
    if (!m || points <= 0) return;
    m.score += points;
    m.lastGain += points;
    m.roundGain += points;
  }

  /** Voting on a face-off closes: count, score, and show who wrote what. */
  private revealFaceoff(): void {
    if (this.phase !== "vote" || this.final) return;
    this.clearTimers();
    const f = this.faceoffs[this.index]!;
    const count = [0, 0];
    const aud = [0, 0];
    for (const [id, c] of f.votes) {
      if (!this.members.has(id)) continue;
      if (this.isWriter(id)) count[c]!++;
      else aud[c]!++;
    }
    const total = count[0]! + count[1]! + aud[0]! + aud[1]!;
    const sweep = (i: number) => total >= ZINGER_MIN_VOTES && count[i]! + aud[i]! === total;
    for (const m of this.members.values()) m.lastGain = 0;
    f.results = [0, 1].map((i) => this.score(f.slots[i]!, count[i]!, aud[i]!, sweep(i), aud[i]! > aud[1 - i]!)) as [Result, Result];
    f.slots.forEach((a, i) => this.award(a, f.results![i]!.points));
    this.phase = "reveal";
    const z = f.results.findIndex((r) => r.zinger);
    if (z >= 0) this.emit("x-zinger-sweep", { round: this.round, name: this.nameOf({ name: f.slots[z]!.authorName }), votes: total });
    this.scheduleNext(this.settings.autoNextSeconds * 1000, () => this.next());
  }

  private revealFinal(): void {
    const fin = this.final;
    if (this.phase !== "vote" || !fin) return;
    this.clearTimers();
    const count = new Map<string, number>();
    const aud = new Map<string, number>();
    for (const [id, spread] of fin.votes) {
      if (!this.members.has(id)) continue;
      const into = this.isWriter(id) ? count : aud;
      for (const [k, n] of Object.entries(spread)) into.set(k, (into.get(k) ?? 0) + n);
    }
    const total = [...count.values(), ...aud.values()].reduce((s, n) => s + n, 0);
    const audTop = Math.max(0, ...aud.values());
    const audTopCount = [...aud.values()].filter((n) => n === audTop).length;
    for (const m of this.members.values()) m.lastGain = 0;
    for (const a of fin.answers) {
      const v = count.get(a.key) ?? 0;
      const av = aud.get(a.key) ?? 0;
      a.result = this.score(a, v, av, total >= ZINGER_MIN_VOTES && v + av === total, audTop > 0 && av === audTop && audTopCount === 1);
      this.award(a, a.result.points);
    }
    // Fewest points first: the best answer comes last.
    fin.answers.sort((x, y) => x.result!.points - y.result!.points || x.result!.votes - y.result!.votes);
    fin.revealed = true;
    this.phase = "reveal";
    const z = fin.answers.find((a) => a.result?.zinger);
    if (z) this.emit("x-zinger-sweep", { round: this.round, name: this.nameOf({ name: z.authorName }), votes: total });
    const auto = this.settings.autoNextSeconds;
    this.scheduleNext(auto > 0 ? Math.max(auto * 2, 12) * 1000 : 0, () => this.next());
  }

  /** The host's Next (and the box's next_round): whatever comes next from here. */
  next(): void {
    this.touch();
    switch (this.phase) {
      case "lobby":
      case "over":
        return this.start();
      case "write":
        return this.closeWriting();
      case "check":
        return this.beginVoting();
      case "vote":
        return this.final ? this.revealFinal() : this.revealFaceoff();
      case "reveal":
        if (this.final) return this.finish();
        if (this.index + 1 < this.faceoffs.length) {
          this.index++;
          return this.startFaceoff();
        }
        return this.toScores();
      case "scores":
        return this.startRound(this.round + 1);
    }
  }

  /** Skip the face-off on screen without counting it. */
  skip(): void {
    if (this.final || (this.phase !== "vote" && this.phase !== "reveal")) throw new GameError("WRONG_PHASE");
    this.touch();
    if (this.phase === "vote") {
      this.clearTimers();
      this.faceoffs[this.index]!.votes.clear();
      this.phase = "reveal"; // then on, as from a reveal (nothing scored)
    }
    this.next();
  }

  private toScores(): void {
    this.clearTimers();
    this.phase = "scores";
    for (const m of this.members.values()) m.lastGain = m.roundGain;
    this.emit("round_ended", { round: this.round });
    const auto = this.settings.autoNextSeconds;
    this.scheduleNext(auto > 0 ? (auto + 6) * 1000 : 0, () => this.next());
  }

  /** The host's End game: straight to the final scores (a face-off on screen isn't counted). */
  endGame(): void {
    if (!IN_GAME.includes(this.phase)) throw new GameError("WRONG_PHASE");
    this.touch();
    this.finish();
  }

  /** Writers, best first, with competition places (1, 1, 3). */
  ranking(): { member: Member; place: number }[] {
    const list = this.writers().sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt);
    return list.map((m) => ({ member: m, place: 1 + list.filter((o) => o.score > m.score).length }));
  }

  private finish(): void {
    this.clearTimers();
    this.paused = false;
    this.phase = "over";
    for (const m of this.members.values()) m.lastGain = 0;
    const ranking = this.ranking();
    const winners = ranking.filter((r) => r.place === 1 && r.member.score > 0).map((r) => r.member);
    this.winners = winners.map((w) => w.id);
    for (const w of winners) this.emit("winner", { name: this.nameOf(w), score: w.score });
    this.emit("game_over", { rounds: this.round, ...(winners.length ? { winners: winners.map((w) => this.nameOf(w)) } : {}) });
    if (ranking.length) {
      const results = ranking.map((r) => ({ player: { name: this.nameOf(r.member) }, place: r.place, score: r.member.score }));
      void bg.reportResults({ roomCode: this.code, results }).catch(() => undefined);
    }
    log.info("room", "game over", { code: this.code, round: this.round, winners: winners.length });
  }

  // ------------------------------------------------------------ views

  private scoreLines(): ScoreLine[] {
    const showGain = this.phase === "reveal" || this.phase === "scores";
    return this.ranking().map(({ member: m, place }) => ({
      id: m.id,
      name: this.nameOf(m),
      score: m.score,
      connected: m.socketIds.size > 0,
      place,
      ...(showGain && m.lastGain > 0 ? { gained: m.lastGain } : {}),
    }));
  }

  /** The lobby's (and host's) list: writers first, then the audience. */
  private people(): PersonLine[] {
    const inGame = this.phase !== "lobby" && this.phase !== "over";
    const writers = new Set(inGame ? this.writerIds : this.pickWriters().map((m) => m.id));
    const doneOf = (id: string) => this.phase === "write" && this.tasksOf(id).every((t) => t.answer.sent);
    const all = this.participants().sort((a, b) => a.joinedAt - b.joinedAt);
    const line = (m: Member): PersonLine => ({
      id: m.id,
      name: this.nameOf(m),
      connected: m.socketIds.size > 0,
      writer: writers.has(m.id),
      ...(this.phase === "write" && writers.has(m.id) ? { done: doneOf(m.id) } : {}),
    });
    return [...all.filter((m) => writers.has(m.id)), ...all.filter((m) => !writers.has(m.id))].map(line);
  }

  private faceoffAnswer(a: Answer, r: Result | undefined, revealed: boolean): FaceoffAnswer {
    const base: FaceoffAnswer = { text: this.textOf(a) };
    if (!revealed) return base;
    return { ...base, author: this.nameOf({ name: a.authorName }), standIn: isStandIn(a), votes: r?.votes ?? 0, audience: r?.audience ?? 0, points: r?.points ?? 0, zinger: !!r?.zinger, audienceBonus: !!r?.audienceBonus };
  }

  view(m: Member): RoomView {
    const runner = this.seats.canRun(m.id);
    const writer = this.isWriter(m.id);
    const voting = this.phase === "vote";
    const showFaceoff = !this.final && (this.phase === "vote" || this.phase === "reveal") && this.faceoffs[this.index];
    const f = showFaceoff ? this.faceoffs[this.index]! : undefined;
    const revealed = this.phase === "reveal";
    const fin = this.final && (this.phase === "vote" || this.phase === "reveal") ? this.final : undefined;
    const you: RoomView["you"] = { id: m.id, role: m.role, name: this.nameOf(m), plays: m.plays, writer, score: m.score };
    if (this.phase === "write" && writer) {
      you.tasks = this.tasksOf(m.id).map(
        (t): WriteTask => ({ id: t.id, prompt: t.prompt.text, text: t.answer.sent ? t.answer.text : t.answer.draft, sent: t.answer.sent }),
      );
    }
    if (f) {
      you.yours = f.slots.some((s) => s.authorId === m.id);
      you.vote = f.votes.get(m.id);
    }
    if (fin) {
      you.finalVotes = fin.votes.get(m.id) ?? {};
      you.finalOwn = fin.answers.find((a) => a.authorId === m.id)?.key;
    }
    if (voting) you.canVote = this.canVote(m);

    let written: RoomView["written"];
    if (this.phase === "write") {
      const all = this.allAnswers();
      written = { sent: all.filter((a) => a.sent).length, total: all.length };
    }
    let votes: RoomView["votes"];
    if (voting) {
      const voters = this.liveVoters();
      const cast = fin ? voters.filter((v) => Object.keys(fin.votes.get(v.id) ?? {}).length > 0).length : voters.filter((v) => f!.votes.has(v.id)).length;
      votes = { cast, voters: voters.length };
    }
    const check: CheckItem[] | undefined = runner
      ? this.checkable().map((c) => ({
          id: c.id,
          prompt: c.prompt.text,
          text: this.settings.filter ? maskProfanity(c.answer.text || c.answer.standIn || "") : c.answer.text || c.answer.standIn || "",
          author: this.nameOf({ name: c.answer.authorName }),
          hidden: c.answer.hidden,
          standIn: !c.answer.text,
        }))
      : undefined;
    const people = this.people();
    const timerPhase = this.mainKind === "phase";
    return {
      code: this.code,
      title: this.title,
      phase: this.phase,
      round: this.round,
      paused: this.paused,
      endsAt: timerPhase ? this.mainAt : undefined,
      pausedLeftMs: this.paused ? this.pausedLeft : undefined,
      timerMs: this.mainMs,
      nextAt: this.mainKind === "next" ? this.mainAt : undefined,
      settings: this.settings,
      writerLimit: writerLimit(),
      people,
      audienceCount: people.filter((p) => !p.writer).length,
      scores: this.scoreLines(),
      faceoff: f
        ? {
            index: this.index + 1,
            total: this.faceoffs.length,
            prompt: f.prompt.text,
            answers: [this.faceoffAnswer(f.slots[0], f.results?.[0], revealed), this.faceoffAnswer(f.slots[1], f.results?.[1], revealed)],
            revealed,
          }
        : undefined,
      final: fin
        ? {
            prompt: fin.prompt.text,
            revealed: fin.revealed,
            answers: fin.answers.map((a) => ({ key: a.key, ...this.faceoffAnswer(a, a.result, fin.revealed) })),
          }
        : undefined,
      written,
      votes,
      check: check && (this.phase === "check" || this.phase === "vote") ? check : undefined,
      promptsReady: runner && (this.phase === "lobby" || this.phase === "over") ? this.promptPool().length : undefined,
      packs: runner ? listPacks() : [],
      hostName: this.hostName(),
      cohosts: m.role === "host" ? this.cohosts().map((c) => ({ id: c.id, name: this.nameOf(c) })) : undefined,
      winners: this.phase === "over" ? this.winners : undefined,
      you,
      serverTime: Date.now(),
    };
  }

  broadcast(): void {
    if (this.closed) return;
    for (const m of this.members.values()) {
      if (!m.socketIds.size) continue;
      const v = this.view(m);
      for (const sid of m.socketIds) this.transport.sendState(sid, v);
    }
  }

  close(reason: string, cause: CloseCause): void {
    if (this.closed) return;
    // Staff or the host ended the session mid-game: it still counts as a finished game.
    if ((cause === "host" || cause === "admin") && IN_GAME.includes(this.phase) && (this.round > 1 || this.phase === "reveal" || this.phase === "scores")) this.finish();
    this.closed = true;
    this.clearTimers();
    for (const m of this.members.values()) for (const sid of m.socketIds) this.transport.sendClosed(sid, reason);
  }
}
