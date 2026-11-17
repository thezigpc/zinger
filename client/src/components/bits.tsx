import { useEffect, useState, type CSSProperties } from "react";
import QRCode from "qrcode";
import { roundName, type RoomView, type ScoreLine } from "@zinger/shared";

export function QrCode({ text, size = 160, className = "qr" }: { text: string; size?: number; className?: string }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    QRCode.toDataURL(text, { margin: 1, width: Math.max(256, size * 2) })
      .then(setSrc)
      .catch(() => setSrc(""));
  }, [text, size]);
  return src ? <img className={className} src={src} width={size} height={size} alt={`QR code for ${text}`} /> : null;
}

/** Re-renders every `ms` while `active`. */
export function useTick(active: boolean, ms = 250): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return now;
}

/** Seconds left until a server time, corrected for clock skew. */
export function secondsLeft(at: number | undefined, skew: number, now: number): number {
  return at ? Math.max(0, Math.ceil((at - (now + skew)) / 1000)) : 0;
}

/** A ring that empties as the phase's time runs out, with the seconds inside. Paused: ⏸. */
export function Countdown({ view, skew, className = "" }: { view: RoomView; skew: number; className?: string }) {
  const now = useTick(!!view.endsAt, 250);
  const total = view.timerMs ?? 0;
  if (!total || (!view.endsAt && !view.paused) || view.nextAt) return null;
  const msLeft = view.paused ? (view.pausedLeftMs ?? 0) : Math.max(0, view.endsAt! - (now + skew));
  const secs = Math.ceil(msLeft / 1000);
  const frac = Math.min(1, msLeft / total);
  const r = 44;
  const c = 2 * Math.PI * r;
  return (
    <div className={`countdown ${secs <= 5 && !view.paused ? "countdown-low" : ""} ${view.paused ? "countdown-paused" : ""} ${className}`} role="timer" aria-label={view.paused ? "Paused" : `${secs} seconds left`}>
      <svg viewBox="0 0 100 100" aria-hidden>
        <circle cx="50" cy="50" r={r} className="countdown-track" />
        <circle cx="50" cy="50" r={r} className="countdown-fill" strokeDasharray={c} strokeDashoffset={c * (1 - frac)} />
      </svg>
      <span>{view.paused ? "⏸" : secs}</span>
    </div>
  );
}

/** "Round 2 · double points" etc. */
export function roundLabel(round: number): string {
  if (round === 2) return `${roundName(2)} · double points`;
  if (round >= 3) return `${roundName(3)} · triple points`;
  return roundName(round);
}

/**
 * The writers by score. `columns`: lay a long list out in two columns (many writers on a TV).
 * `gained` shows "+200" beside anyone who just scored.
 */
export function Scoreboard({ scores, limit, highlight, columns }: { scores: ScoreLine[]; limit?: number; highlight?: string; columns?: boolean }) {
  const list = limit ? scores.slice(0, limit) : scores;
  if (!list.length) return null;
  return (
    <ol className={`scores ${columns ? "scores-cols" : ""}`} style={columns ? ({ "--rows": Math.ceil(list.length / 2) } as CSSProperties) : undefined}>
      {list.map((p) => (
        <li key={p.id} className={`${p.id === highlight ? "me" : ""} ${p.connected ? "" : "away"} ${p.place === 1 && p.score > 0 ? "lead" : ""}`}>
          <span className="scores-place">{p.place}</span>
          <span className="scores-name">{p.name}</span>
          {p.gained ? <span className="scores-gain">+{p.gained}</span> : null}
          <span className="scores-pts">{p.score.toLocaleString()}</span>
        </li>
      ))}
    </ol>
  );
}

const names = (list: string[]) => (list.length <= 1 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`);

/** The end screen's headline. */
export function winnerLine(view: RoomView): string {
  const winners = (view.winners ?? []).map((id) => view.scores.find((s) => s.id === id)?.name).filter((n): n is string => !!n);
  if (!winners.length) return "No points this time!";
  return winners.length === 1 ? `${winners[0]} wins!` : `${names(winners)} share the win!`;
}

/** The answer on a card, quoted. */
export const quoted = (text: string) => `“${text}”`;
