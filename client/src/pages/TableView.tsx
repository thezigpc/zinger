import type { CSSProperties } from "react";
import { isOnBox, joinDisplay } from "@bargames/sdk/client";
import { JoinAddress } from "@bargames/gamekit/client";
import type { FaceoffAnswer, FinalAnswer, RoomView } from "@zinger/shared";
import { Countdown, QrCode, quoted, roundLabel, Scoreboard, secondsLeft, useTick, winnerLine } from "../components/bits";
import { toggleFullscreen } from "../fullscreen";
import { useGameName } from "../useGameName";
import { useVenue } from "../useVenue";
import { nextLabel } from "./HostView";
import type { Act } from "./RoomPage";

/** Name chips get smaller as the room fills (up to 24 writers plus an audience). */
const density = (n: number) => (n > 16 ? "denser" : n > 8 ? "dense" : "");

/**
 * The big screen: the lobby, writing progress, each face-off and its reveal, the Zinger
 * moment, the scores and the final round. Laid out for 1920x1080 CSS seen across a bar (box
 * TVs lay out at that size, 4K included); everything is in vh/vw so 720p and 4K scale the
 * same. Nothing on it needs a pointer. `onHostControls`: a host's own screen, with controls.
 */
export function TableView({ view, skew, act, onHostControls, boxTv }: { view: RoomView; skew: number; act: Act; onHostControls?: () => void; boxTv?: boolean }) {
  const venue = useVenue();
  const gameName = useGameName();
  const join = joinDisplay(venue, `/join/${view.code}`, view.code);
  const address = join.roomShort ?? join.short;
  const logo = isOnBox(venue) ? venue.game.theme.logoUrl : undefined;
  const lobby = view.phase === "lobby";
  // A big final round needs the whole screen: the join corner steps aside (late joiners
  // would only be audience for one vote anyway).
  const corner = !lobby && !(view.final && view.final.answers.length > 12);

  return (
    <div className={`tv tv-phase-${view.phase} ${corner ? "tv-has-corner" : ""}`}>
      <header className="tv-top">
        <div className="tv-title">
          {logo ? <img className="tv-logo" src={logo} alt="" /> : <span className="tv-bolt">⚡</span>}
          <span>{gameName}</span>
        </div>
        <div className="tv-round">{lobby ? "Get your phones out!" : view.phase === "over" ? "Final scores" : roundLabel(view.round)}</div>
        {!boxTv && (
          <button className="icon-btn tv-fs" onClick={toggleFullscreen} title="Full screen" aria-label="Full screen">
            ⛶
          </button>
        )}
      </header>

      <main className="tv-main">
        {lobby && <TvLobby view={view} url={join.url} address={address} />}
        {view.phase === "write" && <TvWriting view={view} skew={skew} />}
        {view.phase === "check" && <TvChecking view={view} skew={skew} />}
        {(view.phase === "vote" || view.phase === "reveal") && view.faceoff && <TvFaceoff view={view} skew={skew} />}
        {(view.phase === "vote" || view.phase === "reveal") && view.final && <TvFinal view={view} skew={skew} />}
        {view.phase === "scores" && <TvScores view={view} skew={skew} />}
        {view.phase === "over" && <TvOver view={view} />}
      </main>

      {corner && (
        <aside className="tv-corner">
          <QrCode text={join.url} size={150} className="qr tv-corner-qr" />
          <div className="tv-corner-text">
            <JoinAddress url={address} minScale={0.8} lines={2} className="tv-join-address" />
            <span className="tv-code">{view.code}</span>
          </div>
        </aside>
      )}

      {view.paused && <div className="tv-paused">⏸ Paused</div>}
      {onHostControls && <TvControls view={view} act={act} onHostControls={onHostControls} />}
    </div>
  );
}

function Names({ view, ticks }: { view: RoomView; ticks?: boolean }) {
  const writers = view.people.filter((p) => p.writer);
  return (
    <ul className={`tv-names ${density(writers.length)}`}>
      {writers.map((p) => (
        <li key={p.id} className={`${p.connected ? "" : "away"} ${ticks && p.done ? "done" : ""}`}>
          {ticks && <span className="tick">{p.done ? "✓" : "✎"}</span>}
          {p.name}
        </li>
      ))}
    </ul>
  );
}

function TvLobby({ view, url, address }: { view: RoomView; url: string; address: string }) {
  const writers = view.people.filter((p) => p.writer).length;
  return (
    <div className="tv-lobby">
      <div className="tv-join">
        <QrCode text={url} size={420} className="qr tv-join-qr" />
        <JoinAddress url={address} minScale={0.8} lines={2} className="tv-join-address" />
        <div className="tv-code-big">{view.code}</div>
      </div>
      <div className="tv-lobby-side">
        <h1 className="tv-headline">
          Be the <span className="zap-text">funniest</span> in the room.
        </h1>
        <ol className="tv-how">
          <li>Write funny answers to prompts on your phone.</li>
          <li>Two answers face off on the TV. Everyone votes.</li>
          <li>Take every vote for a ⚡ Zinger!</li>
        </ol>
        <p className="tv-count">
          {writers === 0 ? "Waiting for writers…" : `${writers} ${writers === 1 ? "writer" : "writers"} in`}
          {view.audienceCount > 0 && <span className="tv-aud"> · {view.audienceCount} in the audience</span>}
        </p>
        <Names view={view} />
        {writers > 0 && writers < 3 && <p className="tv-sub">Zinger needs at least 3 writers.</p>}
      </div>
    </div>
  );
}

function TvWriting({ view, skew }: { view: RoomView; skew: number }) {
  const final = view.round >= 3;
  return (
    <div className="tv-stage">
      <div className="tv-stage-head">
        <div>
          <h1 className="tv-headline">{final ? "The final prompt is on your phones!" : "Grab your phone and write!"}</h1>
          <p className="tv-sub">{final ? "Everyone answers the same prompt. Make it count: triple points." : "Two prompts each. Funny beats clever. Blank answers get a stand-in."}</p>
        </div>
        <Countdown view={view} skew={skew} className="tv-countdown" />
      </div>
      <p className="tv-count">
        {view.written?.sent ?? 0} of {view.written?.total ?? 0} answers in
      </p>
      <Names view={view} ticks />
    </div>
  );
}

function TvChecking({ view, skew }: { view: RoomView; skew: number }) {
  return (
    <div className="tv-stage tv-center">
      <h1 className="tv-headline">Pens down!</h1>
      <p className="tv-sub">The host is giving the answers a quick look…</p>
      <Countdown view={view} skew={skew} className="tv-countdown" />
    </div>
  );
}

function AnswerCard({ a, side, revealed }: { a: FaceoffAnswer; side: 0 | 1; revealed: boolean }) {
  return (
    <div className={`tv-card tv-card-${side} ${revealed ? "revealed" : ""} ${a.zinger ? "zinger" : ""}`}>
      <span className="tv-card-letter">{side === 0 ? "A" : "B"}</span>
      <p className="tv-card-text">{quoted(a.text)}</p>
      {revealed && (
        <div className="tv-card-result">
          <p className="tv-card-author">
            {a.author}
            {a.standIn && <span className="tv-standin"> · stand-in</span>}
          </p>
          <p className="tv-card-votes">
            <span className="tv-card-n">{a.votes}</span> {a.votes === 1 ? "vote" : "votes"}
            {a.audience ? <span className="tv-card-aud"> + {a.audience} audience</span> : null}
          </p>
          <p className="tv-card-pts">+{a.points}</p>
          {a.audienceBonus && <p className="tv-card-badge">👏 Audience favourite</p>}
        </div>
      )}
    </div>
  );
}

function TvFaceoff({ view, skew }: { view: RoomView; skew: number }) {
  const f = view.faceoff!;
  const revealed = f.revealed;
  const zinger = revealed ? f.answers.find((a) => a.zinger) : undefined;
  return (
    <div className="tv-faceoff">
      <p className="tv-faceoff-count">
        Face-off {f.index} of {f.total}
      </p>
      <h1 className="tv-prompt">{f.prompt}</h1>
      <div className="tv-cards">
        <AnswerCard a={f.answers[0]} side={0} revealed={revealed} />
        <div className="tv-vs">{revealed ? <span>vs</span> : <Countdown view={view} skew={skew} className="tv-countdown" />}</div>
        <AnswerCard a={f.answers[1]} side={1} revealed={revealed} />
      </div>
      <p className="tv-status">{revealed ? <NextIn view={view} skew={skew} /> : votesLine(view)}</p>
      {zinger && (
        <div className="tv-zinger" role="status">
          <span className="tv-zinger-word">⚡ ZINGER! ⚡</span>
          <span className="tv-zinger-who">
            {zinger.author} took every vote: +{zinger.points}
          </span>
        </div>
      )}
    </div>
  );
}

const votesLine = (v: RoomView) => (v.votes ? `Vote on your phone! ${v.votes.cast} of ${v.votes.voters} voted` : "Vote on your phone!");

function NextIn({ view, skew }: { view: RoomView; skew: number }) {
  const now = useTick(!!view.nextAt, 500);
  if (!view.nextAt || view.paused) return null;
  return <span className="muted">Next in {secondsLeft(view.nextAt, skew, now)}…</span>;
}

/**
 * Final grid: columns and type size from how many answers there are (3 to 24), so up to
 * 80 characters still fit each card at 1920x1080 CSS.
 */
const GRID: [max: number, cols: number, fs: number][] = [
  [4, 2, 4.2],
  [6, 3, 3.8],
  [9, 3, 3.2],
  [12, 4, 2.9],
  [16, 4, 2.5],
  [20, 5, 2.3],
  [24, 6, 2.15],
];
function gridStyle(n: number): CSSProperties {
  const [, cols, fs] = GRID.find(([max]) => n <= max) ?? GRID[GRID.length - 1]!;
  return { "--cols": Math.min(cols, Math.max(n, 1)), "--fs": `${fs}vh` } as CSSProperties;
}

function FinalCard({ a, i, revealed, best }: { a: FinalAnswer; i: number; revealed: boolean; best: boolean }) {
  return (
    <li className={`tv-fcard ${revealed ? "revealed" : ""} ${best ? "best" : ""} ${a.zinger ? "zinger" : ""}`} style={revealed ? ({ "--i": i } as CSSProperties) : undefined}>
      <p className="tv-fcard-text">{quoted(a.text)}</p>
      {revealed && (
        <p className="tv-fcard-result">
          <span className="tv-fcard-author">{a.author}</span>
          <span className="tv-fcard-votes">
            {a.votes}🗳{a.audience ? ` +${a.audience}` : ""}
          </span>
          <span className="tv-fcard-pts">+{a.points}</span>
        </p>
      )}
    </li>
  );
}

function TvFinal({ view, skew }: { view: RoomView; skew: number }) {
  const fin = view.final!;
  const n = fin.answers.length;
  const top = Math.max(0, ...fin.answers.map((a) => a.points ?? 0));
  return (
    <div className={`tv-final-round ${n > 12 ? "tv-full" : ""}`}>
      <div className="tv-stage-head">
        <h1 className="tv-prompt">{fin.prompt}</h1>
        {!fin.revealed && <Countdown view={view} skew={skew} className="tv-countdown" />}
      </div>
      <ol className="tv-fgrid" style={gridStyle(n)}>
        {fin.answers.map((a, i) => (
          <FinalCard key={a.key} a={a} i={i} revealed={fin.revealed} best={fin.revealed && top > 0 && a.points === top} />
        ))}
      </ol>
      <p className="tv-status">{fin.revealed ? <NextIn view={view} skew={skew} /> : `Spread your 3 votes on your phone! ${view.votes?.cast ?? 0} of ${view.votes?.voters ?? 0} voted`}</p>
    </div>
  );
}

function TvScores({ view, skew }: { view: RoomView; skew: number }) {
  const n = view.scores.length;
  return (
    <div className="tv-board">
      <h1 className="tv-headline">{roundLabel(view.round)}: the scores</h1>
      <div className={`tv-board-list ${density(n)}`}>
        <Scoreboard scores={view.scores} columns={n > 8} />
      </div>
      <p className="tv-sub">
        {view.round === 1 ? "Up next: round 2. Every vote is worth double!" : "Up next: the final round. One prompt for everyone, triple points."} <NextIn view={view} skew={skew} />
      </p>
    </div>
  );
}

function TvOver({ view }: { view: RoomView }) {
  const n = view.scores.length;
  return (
    <div className="tv-board">
      <h1 className="tv-headline tv-winner">🏆 {winnerLine(view)}</h1>
      <div className={`tv-board-list ${density(n)}`}>
        <Scoreboard scores={view.scores} columns={n > 8} />
      </div>
    </div>
  );
}

/** The host running the game from this big screen (an iPad or laptop on a TV). */
function TvControls({ view, act, onHostControls }: { view: RoomView; act: Act; onHostControls: () => void }) {
  const inGame = view.phase !== "lobby" && view.phase !== "over";
  return (
    <nav className="tv-controls">
      <button className="btn btn-primary" onClick={() => act(view.phase === "lobby" ? "start" : "next")}>
        {nextLabel(view)}
      </button>
      {inGame && (
        <button className="btn btn-ghost" onClick={() => act(view.paused ? "resume" : "pause")}>
          {view.paused ? "▶ Resume" : "⏸ Pause"}
        </button>
      )}
      {view.phase === "check" && (
        <button className="btn btn-ghost" onClick={onHostControls}>
          Check answers
        </button>
      )}
      <button className="btn btn-ghost" onClick={onHostControls}>
        ⚙ Host controls
      </button>
    </nav>
  );
}
