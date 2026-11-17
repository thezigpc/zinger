import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { BackToGames } from "@bargames/gamekit/client";
import type { JoinResult } from "@zinger/shared";
import { call } from "../socket";
import { getSettingsDefault, lastName, loadSession, rememberName, saveSession, setBigScreen } from "../session";
import { useGameName } from "../useGameName";
import { useVenue } from "../useVenue";

export function HomePage() {
  const navigate = useNavigate();
  const params = useParams();
  const [search] = useSearchParams();
  const gameName = useGameName();
  const venue = useVenue();
  const [code, setCode] = useState((params.code ?? "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4));
  const [name, setName] = useState(lastName());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const cohostInvite = search.get("cohost") ?? undefined;

  const enter = (r: JoinResult) => {
    saveSession({ roomCode: r.code, token: r.token, name: r.name, role: r.role });
    navigate(`/room/${r.code}`, { replace: true });
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  // /join/ABCD?host=<key>: the host link (the box's "Open the host controls", or a take-over).
  // It resumes the host seat; the server answers with that seat's own token.
  useEffect(() => {
    const hostKey = search.get("host");
    if (hostKey && code.length === 4) {
      saveSession({ roomCode: code, token: hostKey, name: "Host", role: "host" });
      navigate(`/room/${code}`, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const host = (onScreen: boolean) =>
    run(async () => {
      if (name.trim()) rememberName(name.trim());
      if (!onScreen && !name.trim()) throw new Error("Enter your name: you'll be playing too.");
      const r = await call<JoinResult>("createRoom", { name: name.trim() || "Host", plays: !onScreen, settings: getSettingsDefault() ?? undefined });
      if (onScreen) setBigScreen(r.code, true);
      enter(r);
    });

  const join = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      const roomCode = code.trim().toUpperCase();
      if (roomCode.length !== 4) throw new Error("Room codes are 4 letters.");
      const existing = loadSession();
      const token = existing?.roomCode === roomCode && existing.role !== "table" ? existing.token : undefined;
      rememberName(name.trim());
      enter(await call<JoinResult>("joinRoom", { code: roomCode, role: "player", name: name.trim(), token, cohost: cohostInvite }));
    });
  };

  return (
    <main className="home">
      <header className="home-hero">
        <div className="hero-mark" aria-hidden>
          <span className="hero-bolt">⚡</span>
        </div>
        <h1>{gameName}</h1>
        <p className="muted">Write the funniest answer. Everyone votes. Sweep every vote for a Zinger.</p>
      </header>

      <form className="panel" onSubmit={join}>
        <h2>{cohostInvite ? "Join as a co-host" : "Join a game"}</h2>
        {cohostInvite && <p className="muted small">You'll be able to start the game, move it on, pause, hide answers and change the settings. This link works once.</p>}
        <label>
          Room code
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4))}
            placeholder="ABCD"
            autoCapitalize="characters"
            autoComplete="off"
            className="code-input"
          />
        </label>
        <label>
          Your name
          <input value={name} onChange={(e) => setName(e.target.value.slice(0, 20))} placeholder="Name" autoComplete="nickname" />
        </label>
        <button className="btn btn-primary btn-big" disabled={busy || code.length !== 4 || !name.trim()}>
          {cohostInvite ? "Join as co-host" : "Join"}
        </button>
      </form>

      {!cohostInvite && (
        <section className="panel">
          <h2>Host a game</h2>
          <p className="muted">3 or more players write on their phones; the face-offs play on a screen everyone can see.</p>
          <button className="btn btn-secondary btn-big" disabled={busy} onClick={() => host(false)}>
            📱 Host and play
          </button>
          <button className="btn btn-ghost btn-big" disabled={busy} onClick={() => host(true)}>
            📺 Host on this screen
          </button>
          <p className="muted small">For a laptop or iPad on a TV: the big view with the controls on it (this screen doesn't play).</p>
        </section>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <footer className="home-foot">
        <Link to="/admin" className="muted small">
          Admin
        </Link>
      </footer>

      {/* Bar Games: back to the venue's games list. Landing page only; nothing off a box. */}
      {!search.get("host") && !cohostInvite && <BackToGames ctx={venue} />}
    </main>
  );
}
