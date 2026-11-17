import { useEffect, useRef, useState } from "react";
import { ANSWER_MAX, FINAL_VOTES, type FaceoffAnswer, type RoomView, type WriteTask } from "@zinger/shared";
import { Countdown, quoted, roundLabel, Scoreboard, winnerLine } from "../components/bits";
import { socket } from "../socket";
import { getDraft, setDraft } from "../session";
import type { Act } from "./RoomPage";

/** Everything a player does on their phone; hosts who play get the same pieces. */
export function PlayerView({ view, skew, act }: { view: RoomView; skew: number; act: Act }) {
  return (
    <main className="player">
      {view.paused && <p className="paused-strip">⏸ Paused by the host</p>}
      <PlayArea view={view} skew={skew} act={act} />
    </main>
  );
}

/** The phase's interactive part (also inside the host's game panel when the host plays). */
export function PlayArea({ view, skew, act }: { view: RoomView; skew: number; act: Act }) {
  const you = view.you;
  switch (view.phase) {
    case "lobby":
      return (
        <section className="panel center">
          <h2>You're in, {you.name}!</h2>
          {you.plays ? (
            <p className="muted">
              {view.people.find((p) => p.id === you.id)?.writer
                ? "You'll be writing. Get your funny ready: the host starts soon."
                : `The writing seats are full (${view.settings.maxWriters}), so you're in the audience: you'll vote on every face-off.`}
            </p>
          ) : (
            <p className="muted">You're running the game from this screen.</p>
          )}
          <p className="muted small">{playersLine(view)}</p>
        </section>
      );
    case "write":
      return you.writer ? <WriteTasks view={view} skew={skew} act={act} /> : <Waiting view={view} skew={skew} title="The writers are writing…" note="You're in the audience: you'll vote on every face-off." />;
    case "check":
      return <Waiting view={view} skew={skew} title="Answers are in!" note="The host is giving them a quick look. Eyes on the TV." />;
    case "vote":
      return view.final ? <FinalVote view={view} skew={skew} act={act} /> : <FaceoffVote view={view} skew={skew} act={act} />;
    case "reveal":
      return view.final ? <FinalReveal view={view} /> : <FaceoffReveal view={view} />;
    case "scores":
      return <ScoresCard view={view} />;
    case "over":
      return <OverCard view={view} />;
  }
}

const playersLine = (v: RoomView) => {
  const writers = v.people.filter((p) => p.writer).length;
  return `${writers} writing${v.audienceCount ? ` · ${v.audienceCount} in the audience` : ""}`;
};

function Waiting({ view, skew, title, note }: { view: RoomView; skew: number; title: string; note?: string }) {
  return (
    <section className="panel center">
      <p className="round-tag">{roundLabel(view.round)}</p>
      <Countdown view={view} skew={skew} />
      <h2>{title}</h2>
      {note && <p className="muted">{note}</p>}
      {view.written && (
        <p className="muted small">
          {view.written.sent} of {view.written.total} answers in
        </p>
      )}
    </section>
  );
}

/** The writer's prompts: one card at a time, then a summary with Edit. */
function WriteTasks({ view, skew, act }: { view: RoomView; skew: number; act: Act }) {
  const tasks = view.you.tasks ?? [];
  const [editing, setEditing] = useState<string | null>(null);
  const current = editing ? tasks.find((t) => t.id === editing) : tasks.find((t) => !t.sent);
  const n = tasks.indexOf(current as WriteTask) + 1;
  return (
    <section className="write">
      <div className="write-head">
        <p className="round-tag">{roundLabel(view.round)}</p>
        <Countdown view={view} skew={skew} />
      </div>
      {current ? (
        <AnswerCard
          key={current.id}
          code={view.code}
          task={current}
          label={tasks.length > 1 ? `Prompt ${n} of ${tasks.length}` : "The final prompt: everyone answers this one"}
          act={act}
          onSent={() => setEditing(null)}
        />
      ) : (
        <div className="panel center">
          <h2>All sent! ✔</h2>
          <p className="muted">Watch the TV. You can still change an answer until time's up.</p>
          <ul className="sent-list">
            {tasks.map((t) => (
              <li key={t.id}>
                <p className="sent-prompt">{t.prompt}</p>
                <p className="sent-text">{quoted(t.text)}</p>
                <button className="link-btn" onClick={() => setEditing(t.id)}>
                  Edit
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function AnswerCard({ code, task, label, act, onSent }: { code: string; task: WriteTask; label: string; act: Act; onSent: () => void }) {
  const [text, setText] = useState(() => getDraft(code, task.id) || task.text);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  // Drafts go to the server too (no ack, no broadcast): if this phone drops, the answer
  // typed so far still counts when writing closes.
  const change = (v: string) => {
    const t = v.replace(/\n/g, " ").slice(0, ANSWER_MAX);
    setText(t);
    setDraft(code, task.id, t);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => socket.emit("draft", { id: task.id, text: t }), 600);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    clearTimeout(timer.current);
    const r = await act("answer", { id: task.id, text });
    setBusy(false);
    if (r) {
      setDraft(code, task.id, "");
      onSent();
    }
  };
  const left = ANSWER_MAX - text.length;
  return (
    <form
      className="panel answer-card"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <p className="muted small">{label}</p>
      <h2 className="answer-prompt">{task.prompt}</h2>
      <textarea
        value={text}
        onChange={(e) => change(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void send();
          }
        }}
        placeholder="Your funniest answer"
        rows={3}
        maxLength={ANSWER_MAX}
        autoFocus
        aria-label="Your answer"
        enterKeyHint="send"
      />
      <p className={`char-count ${left <= 10 ? "low" : ""}`}>{left} left</p>
      <button className="btn btn-primary btn-big" disabled={busy || !text.trim()}>
        {task.sent ? "Update answer" : "Send"}
      </button>
    </form>
  );
}

/** Two answers, two big buttons. Not on your own face-off. */
function FaceoffVote({ view, skew, act }: { view: RoomView; skew: number; act: Act }) {
  const f = view.faceoff!;
  const you = view.you;
  return (
    <section className="vote">
      <div className="vote-head">
        <p className="round-tag">
          Face-off {f.index} of {f.total}
        </p>
        <Countdown view={view} skew={skew} />
      </div>
      <h2 className="vote-prompt">{f.prompt}</h2>
      {you.yours ? (
        <div className="panel center">
          <p className="you-big">This one's yours! 🤞</p>
          <p className="muted">Sit back while the room votes.</p>
        </div>
      ) : !you.canVote ? (
        <p className="muted center">Voting on the TV…</p>
      ) : (
        <>
          {f.answers.map((a, i) => (
            <button key={i} className={`vote-btn vote-${i} ${you.vote === i ? "picked" : ""} ${you.vote !== undefined && you.vote !== i ? "other" : ""}`} onClick={() => void act("vote", i)} aria-pressed={you.vote === i}>
              <span className="vote-letter">{i === 0 ? "A" : "B"}</span>
              <span className="vote-label">{a.text}</span>
              {you.vote === i && <span className="vote-check">✓</span>}
            </button>
          ))}
          <p className="muted small center">{you.vote !== undefined ? "Vote in. You can still change it." : "Tap the funnier one."}</p>
        </>
      )}
    </section>
  );
}

/** Final round: spread FINAL_VOTES votes; never on your own answer. */
function FinalVote({ view, skew, act }: { view: RoomView; skew: number; act: Act }) {
  const fin = view.final!;
  const you = view.you;
  const [spread, setSpread] = useState<Record<string, number>>(you.finalVotes ?? {});
  useEffect(() => setSpread(you.finalVotes ?? {}), [JSON.stringify(you.finalVotes)]); // eslint-disable-line react-hooks/exhaustive-deps
  const used = Object.values(spread).reduce((s, n) => s + n, 0);
  const left = FINAL_VOTES - used;
  const change = (key: string, d: number) => {
    const next = { ...spread, [key]: Math.max(0, (spread[key] ?? 0) + d) };
    if (!next[key]) delete next[key];
    setSpread(next);
    void act("finalVote", next);
  };
  return (
    <section className="vote">
      <div className="vote-head">
        <p className="round-tag">Final vote</p>
        <Countdown view={view} skew={skew} />
      </div>
      <h2 className="vote-prompt">{fin.prompt}</h2>
      {you.canVote ? (
        <p className="votes-left">
          {left > 0 ? (
            <>
              {"🗳".repeat(left)} {left} {left === 1 ? "vote" : "votes"} left: spread them or stack them
            </>
          ) : (
            "All votes in ✓ (tap − to move one)"
          )}
        </p>
      ) : (
        <p className="muted center">Voting on the TV…</p>
      )}
      <ul className="final-list">
        {fin.answers.map((a) => {
          const mine = a.key === you.finalOwn;
          const n = spread[a.key] ?? 0;
          return (
            <li key={a.key} className={`final-item ${mine ? "mine" : ""} ${n ? "has-votes" : ""}`}>
              <span className="final-text">{a.text}</span>
              {mine ? (
                <span className="muted small">Yours</span>
              ) : you.canVote ? (
                <span className="stepper">
                  <button className="step" disabled={n === 0} onClick={() => change(a.key, -1)} aria-label="One vote less">
                    −
                  </button>
                  <span className="step-n">{n}</span>
                  <button className="step" disabled={left === 0} onClick={() => change(a.key, 1)} aria-label="One vote more">
                    +
                  </button>
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function AnswerResult({ a, youId, view }: { a: FaceoffAnswer; youId?: string; view: RoomView }) {
  const mine = youId && view.scores.find((s) => s.id === youId)?.name === a.author;
  return (
    <div className={`result ${a.zinger ? "result-zinger" : ""} ${mine ? "result-mine" : ""}`}>
      <p className="result-text">{quoted(a.text)}</p>
      <p className="result-who">
        <strong>{a.author}</strong>
        {a.standIn ? <span className="muted small"> · stand-in, no points</span> : null}
      </p>
      <p className="result-nums">
        {a.votes} {a.votes === 1 ? "vote" : "votes"}
        {a.audience ? ` · ${a.audience} audience` : ""}
        <strong className="result-pts">+{a.points}</strong>
      </p>
      {a.zinger && <p className="zinger-tag">⚡ ZINGER!</p>}
      {a.audienceBonus && <p className="small">👏 Audience favourite</p>}
    </div>
  );
}

function FaceoffReveal({ view }: { view: RoomView }) {
  const f = view.faceoff!;
  return (
    <section className="reveal">
      <h2 className="vote-prompt">{f.prompt}</h2>
      {f.answers.map((a, i) => (
        <AnswerResult key={i} a={a} youId={view.you.id} view={view} />
      ))}
      <YourScore view={view} />
    </section>
  );
}

function FinalReveal({ view }: { view: RoomView }) {
  const fin = view.final!;
  return (
    <section className="reveal">
      <h2 className="vote-prompt">{fin.prompt}</h2>
      {[...fin.answers].reverse().map((a) => (
        <AnswerResult key={a.key} a={a} youId={view.you.id} view={view} />
      ))}
      <YourScore view={view} />
    </section>
  );
}

function YourScore({ view }: { view: RoomView }) {
  if (!view.you.writer) return null;
  const me = view.scores.find((s) => s.id === view.you.id);
  return (
    <p className="muted center you-score">
      Your score: {view.you.score.toLocaleString()}
      {me?.gained ? ` (+${me.gained})` : ""} · place {me?.place ?? "–"}
    </p>
  );
}

function ScoresCard({ view }: { view: RoomView }) {
  return (
    <section className="panel center">
      <h2>{roundLabel(view.round)}: done!</h2>
      <Scoreboard scores={view.scores} highlight={view.you.id} />
      <p className="muted small">{view.round === 1 ? "Next: round 2, double points." : "Next: the final round. One prompt, everyone answers."}</p>
    </section>
  );
}

function OverCard({ view }: { view: RoomView }) {
  const won = view.winners?.includes(view.you.id);
  return (
    <section className="panel center">
      <h2>{won ? (view.winners!.length > 1 ? "🏆 You share the win!" : "🏆 You win!") : `🏆 ${winnerLine(view)}`}</h2>
      <Scoreboard scores={view.scores} highlight={view.you.id} />
      <p className="muted small">Stay here: the host can start another game.</p>
    </section>
  );
}
