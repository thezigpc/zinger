import { useState } from "react";
import { JoinAddress } from "@bargames/gamekit/client";
import { joinDisplay, joinUrl } from "@bargames/sdk/client";
import { AUTO_NEXT_CHOICES, VOTE_CHOICES, WRITE_CHOICES, type Rating, type RoomSettings, type RoomView } from "@zinger/shared";
import { Countdown, QrCode, quoted, roundLabel, Scoreboard, secondsLeft, useTick, winnerLine } from "../components/bits";
import { call } from "../socket";
import { setSettingsDefault } from "../session";
import { useVenue } from "../useVenue";
import { PlayArea } from "./PlayerView";
import type { Act } from "./RoomPage";

export function HostView({ view, skew, act }: { view: RoomView; skew: number; act: Act }) {
  const isHost = view.you.role === "host";
  const playing = view.you.plays && view.phase !== "lobby" && view.phase !== "over";
  return (
    <main className="host">
      <GamePanel view={view} skew={skew} act={act} />
      {view.check && view.check.length > 0 && <CheckPanel view={view} act={act} />}
      {playing && (
        <section className="host-play">
          <h3>You're playing</h3>
          <PlayArea view={view} skew={skew} act={act} />
        </section>
      )}
      <SettingsPanel view={view} act={act} />
      <JoinPanel view={view} />
      <PeoplePanel view={view} act={act} isHost={isHost} />
      {isHost && (
        <section className="panel">
          <button
            className="btn btn-danger"
            onClick={() => {
              if (window.confirm("Close this room for everyone?")) void act("closeRoom");
            }}
          >
            Close room
          </button>
        </section>
      )}
    </main>
  );
}

/** What Next does in each phase (the host's main button). */
export function nextLabel(view: RoomView): string {
  switch (view.phase) {
    case "lobby":
      return "Start the game";
    case "write":
      return "End writing now";
    case "check":
      return "Looks good: start voting";
    case "vote":
      return "Reveal now";
    case "reveal":
      if (view.final) return "Final scores";
      return view.faceoff && view.faceoff.index < view.faceoff.total ? "Next face-off" : "Round scores";
    case "scores":
      return view.round === 1 ? "Start round 2" : "Start the final round";
    case "over":
      return "Play again";
  }
}

function GamePanel({ view, skew, act }: { view: RoomView; skew: number; act: Act }) {
  const now = useTick(!!view.nextAt, 500);
  const inGame = view.phase !== "lobby" && view.phase !== "over";
  const writers = view.people.filter((p) => p.writer).length;
  return (
    <section className="panel game-panel">
      {view.phase === "lobby" ? (
        <>
          <h2>Ready when you are</h2>
          <p className="muted">
            {writers} {writers === 1 ? "writer" : "writers"}
            {view.audienceCount ? `, ${view.audienceCount} in the audience` : ""}. {view.promptsReady ?? 0} prompts ready.
          </p>
          {writers < 3 && <p className="warning">Zinger needs at least 3 writers. Get more phones in!</p>}
        </>
      ) : (
        <div className="game-status">
          <div>
            <p className="round-tag">{view.phase === "over" ? "Game over" : roundLabel(view.round)}</p>
            <p className="game-what">{phaseLine(view)}</p>
          </div>
          {inGame && <Countdown view={view} skew={skew} />}
        </div>
      )}
      {view.phase === "over" && (
        <>
          <p className="you-big">🏆 {winnerLine(view)}</p>
          <Scoreboard scores={view.scores} limit={12} />
        </>
      )}
      {view.nextAt && !view.paused && <p className="muted small">Moving on in {secondsLeft(view.nextAt, skew, now)}…</p>}
      <div className="btn-row">
        <button className="btn btn-primary btn-big" onClick={() => act(view.phase === "lobby" ? "start" : "next")}>
          {nextLabel(view)}
        </button>
        {inGame && (
          <button className="btn btn-ghost" onClick={() => act(view.paused ? "resume" : "pause")}>
            {view.paused ? "▶ Resume" : "⏸ Pause"}
          </button>
        )}
        {!view.final && (view.phase === "vote" || view.phase === "reveal") && (
          <button className="btn btn-ghost" onClick={() => act("skip")}>
            Skip face-off
          </button>
        )}
        {inGame && (
          <button
            className="btn btn-ghost"
            onClick={() => {
              if (window.confirm("End the game now and show the final scores?")) void act("endGame");
            }}
          >
            End game
          </button>
        )}
      </div>
    </section>
  );
}

function phaseLine(v: RoomView): string {
  switch (v.phase) {
    case "write":
      return `Writing: ${v.written?.sent ?? 0} of ${v.written?.total ?? 0} answers in`;
    case "check":
      return "Check the answers below; hide any that shouldn't go on the TV.";
    case "vote":
      return v.final ? `Final vote: ${v.votes?.cast ?? 0} of ${v.votes?.voters ?? 0} voted` : `Face-off ${v.faceoff?.index} of ${v.faceoff?.total}: ${v.votes?.cast ?? 0} of ${v.votes?.voters ?? 0} voted`;
    case "reveal":
      return v.final ? "The final results" : `Face-off ${v.faceoff?.index} of ${v.faceoff?.total}: the reveal`;
    case "scores":
      return "Round scores on the TV";
    default:
      return "";
  }
}

/** Moderation: every answer before the TV shows it; Hide swaps in a stand-in (no points). */
function CheckPanel({ view, act }: { view: RoomView; act: Act }) {
  const items = view.check ?? [];
  const byPrompt = new Map<string, typeof items>();
  for (const it of items) byPrompt.set(it.prompt, [...(byPrompt.get(it.prompt) ?? []), it]);
  return (
    <section className="panel check-panel">
      <h3>{view.phase === "check" ? "Check the answers" : "Answers not shown yet"}</h3>
      <p className="muted small">Hidden answers show as a stand-in joke on the TV and score nothing.{view.settings.filter ? " The swear filter is on." : ""}</p>
      {[...byPrompt].map(([prompt, list]) => (
        <div key={prompt} className="check-group">
          <p className="check-prompt">{prompt}</p>
          <ul>
            {list.map((it) => (
              <li key={it.id} className={it.hidden ? "is-hidden" : ""}>
                <span className="check-text">
                  {quoted(it.text)}
                  <small className="muted">
                    {" "}
                    · {it.author}
                    {it.standIn ? " (no answer: stand-in)" : ""}
                  </small>
                </span>
                {!it.standIn && (
                  <button className="btn btn-ghost btn-small" onClick={() => act("hide", { id: it.id, hidden: !it.hidden })}>
                    {it.hidden ? "Show" : "Hide"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function SettingsPanel({ view, act }: { view: RoomView; act: Act }) {
  const s = view.settings;
  const set = async (patch: Partial<RoomSettings>) => {
    const r = await act("updateSettings", patch);
    if (r) setSettingsDefault({ ...s, ...patch }); // this device's defaults for its next room
  };
  const togglePack = (id: string, on: boolean) => void set({ packIds: on ? [...s.packIds, id] : s.packIds.filter((x) => x !== id) });
  const writerChoices = Array.from({ length: view.writerLimit - 2 }, (_, i) => i + 3);
  return (
    <section className="panel settings">
      <h3>Settings</h3>
      <label className="row">
        <span>Prompts</span>
        <select value={s.rating} onChange={(e) => void set({ rating: e.target.value as Rating })}>
          <option value="family">Family friendly</option>
          <option value="spicy">Spicy only</option>
          <option value="both">Family and spicy</option>
        </select>
      </label>
      <label className="row">
        <span>
          Writers per game
          <small className="muted">Everyone past this is audience. Up to {view.writerLimit} (set on the admin page).</small>
        </span>
        <select value={s.maxWriters} onChange={(e) => void set({ maxWriters: Number(e.target.value) })}>
          {writerChoices.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <label className="row">
        <span>Writing time</span>
        <select value={s.writeSeconds} onChange={(e) => void set({ writeSeconds: Number(e.target.value) })}>
          {[...new Set([...WRITE_CHOICES, s.writeSeconds])].sort((x, y) => x - y).map((t) => (
            <option key={t} value={t}>
              {t} seconds
            </option>
          ))}
        </select>
      </label>
      <label className="row">
        <span>Voting time</span>
        <select value={s.voteSeconds} onChange={(e) => void set({ voteSeconds: Number(e.target.value) })}>
          {[...new Set([...VOTE_CHOICES, s.voteSeconds])].sort((x, y) => x - y).map((t) => (
            <option key={t} value={t}>
              {t} seconds
            </option>
          ))}
        </select>
      </label>
      <label className="row">
        <span>After a reveal</span>
        <select value={s.autoNextSeconds} onChange={(e) => void set({ autoNextSeconds: Number(e.target.value) })}>
          {[...new Set([...AUTO_NEXT_CHOICES, s.autoNextSeconds])].sort((x, y) => x - y).map((n) => (
            <option key={n} value={n}>
              {n === 0 ? "Wait for Next" : `Next by itself after ${n} s`}
            </option>
          ))}
        </select>
      </label>
      <label className="row check">
        <input type="checkbox" checked={s.filter} onChange={(e) => void set({ filter: e.target.checked })} />
        <span>
          Swear filter
          <small className="muted">Masks swear words in answers and names.</small>
        </span>
      </label>
      <label className="row check">
        <input type="checkbox" checked={s.check} onChange={(e) => void set({ check: e.target.checked })} />
        <span>
          Check answers before the TV
          <small className="muted">After writing you get a quick look at every answer and can hide any. Skipped when no host is connected.</small>
        </span>
      </label>
      <fieldset className="packs">
        <legend>Prompt packs</legend>
        {view.packs.map((p) => (
          <label key={p.id} className="row check">
            <input type="checkbox" checked={s.packIds.includes(p.id)} onChange={(e) => togglePack(p.id, e.target.checked)} />
            <span>
              {p.name}{" "}
              <small className="muted">
                ({p.family} family, {p.spicy} spicy)
              </small>
            </span>
          </label>
        ))}
      </fieldset>
    </section>
  );
}

function JoinPanel({ view }: { view: RoomView }) {
  const venue = useVenue();
  const join = joinDisplay(venue, `/join/${view.code}`, view.code);
  const tvLink = joinUrl(venue, `/room/${view.code}?role=table`);
  return (
    <section className="panel join-panel">
      <h3>Join and TV</h3>
      <div className="join-box">
        <QrCode text={join.url} size={150} />
        <div>
          <JoinAddress url={join.roomShort ?? join.short} align="start" />
          <p className="room-code-big">{view.code}</p>
        </div>
      </div>
      <a className="btn btn-ghost" href={tvLink} target="_blank" rel="noreferrer">
        Open the TV view in a new tab
      </a>
    </section>
  );
}

function PeoplePanel({ view, act, isHost }: { view: RoomView; act: Act; isHost: boolean }) {
  const [invite, setInvite] = useState<{ url: string; expiresAt: string } | null>(null);
  const venue = useVenue();
  const lobby = view.phase === "lobby" || view.phase === "over";
  const makeInvite = async () => {
    try {
      const r = await call<{ path: string; expiresAt: string }>("cohostInvite");
      setInvite({ url: joinUrl(venue, r.path), expiresAt: r.expiresAt });
    } catch {
      /* nothing to show: the button just does nothing */
    }
  };
  const writers = view.people.filter((p) => p.writer);
  const audience = view.people.filter((p) => !p.writer);
  return (
    <section className="panel people">
      {lobby && (
        <label className="row check">
          <input type="checkbox" checked={view.you.plays} onChange={(e) => void act("setPlaying", e.target.checked)} />
          <span>
            I'm playing too
            <small className="muted">Off: this device only runs the game.</small>
          </span>
        </label>
      )}
      <h3>Writers ({writers.length})</h3>
      {view.phase !== "lobby" && view.scores.length > 0 ? (
        <Scoreboard scores={view.scores} />
      ) : (
        <ul className="names">
          {writers.map((p) => (
            <li key={p.id} className={p.connected ? "" : "away"}>
              {p.name}
            </li>
          ))}
        </ul>
      )}
      {audience.length > 0 && (
        <>
          <h4>Audience ({audience.length})</h4>
          <ul className="names">
            {audience.map((p) => (
              <li key={p.id} className={p.connected ? "" : "away"}>
                {p.name}
              </li>
            ))}
          </ul>
        </>
      )}
      {isHost && view.people.length > 0 && (
        <details>
          <summary className="muted small">Remove a player</summary>
          <ul className="names">
            {view.people
              .filter((p) => p.id !== view.you.id)
              .map((p) => (
                <li key={p.id}>
                  {p.name}{" "}
                  <button
                    className="link-btn small"
                    onClick={() => {
                      if (window.confirm(`Remove ${p.name}?`)) void act("kick", p.id);
                    }}
                  >
                    Remove
                  </button>
                </li>
              ))}
          </ul>
        </details>
      )}
      {isHost && (
        <div className="cohosts">
          <h4>Co-hosts</h4>
          {view.cohosts?.length ? (
            <ul className="names">
              {view.cohosts.map((c) => (
                <li key={c.id}>
                  {c.name}{" "}
                  <button className="link-btn small" onClick={() => void act("removeCohost", c.id)}>
                    Make a player
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">A co-host can run the game with you, but can't close the room or remove anyone.</p>
          )}
          {invite ? (
            <div className="join-box">
              <QrCode text={invite.url} size={150} />
              <p className="muted small">
                Scan to join as a co-host. Works once, until {new Date(invite.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.
              </p>
            </div>
          ) : null}
          <button className="btn btn-ghost" onClick={() => void makeInvite()}>
            {invite ? "New co-host link" : "Add a co-host"}
          </button>
        </div>
      )}
    </section>
  );
}
