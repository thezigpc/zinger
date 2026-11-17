import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { AUTO_NEXT_CHOICES, VOTE_CHOICES, WRITE_CHOICES, WRITER_LIMIT, type AdminOverview, type Rating, type RoomSettings } from "@zinger/shared";
import { BoxAdminLink, staffSignIn } from "@bargames/gamekit/client";
import { serverUrl } from "../socket";
import { useVenue } from "../useVenue";

const TOKEN_KEY = "zinger_admin_token";
const loadToken = () => {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
};
const saveToken = (t: string) => {
  try {
    if (t) sessionStorage.setItem(TOKEN_KEY, t);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode */
  }
};

type Init = { method?: string; body?: unknown; raw?: BodyInit; query?: Record<string, string> };

async function api<T>(path: string, token: string, init: Init = {}): Promise<T> {
  const q = init.query ? `?${new URLSearchParams(init.query)}` : "";
  const res = await fetch(`${serverUrl}/api/admin${path}${q}`, {
    method: init.method ?? (init.body !== undefined || init.raw !== undefined ? "POST" : "GET"),
    headers: {
      ...(init.raw === undefined ? { "content-type": "application/json" } : { "content-type": "application/octet-stream" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error ?? `Request failed (${res.status}).`), { status: res.status });
  return body as T;
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`;
}

interface AdminStatus {
  setupNeeded: boolean;
  authenticated: boolean;
  trusted?: boolean;
  venueLogin?: boolean;
  setupAllowed?: boolean;
}

export function AdminPage() {
  const [token, setToken] = useState(loadToken);
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [error, setError] = useState("");
  const [signedOut, setSignedOut] = useState(false);
  const venue = useVenue();

  const refreshStatus = useCallback(() => {
    api<AdminStatus>("/status", token)
      .then(async (s) => {
        // Staff the venue box vouches for (SDK 0.7.0): in without the password. Never off a box.
        if (!s.authenticated && s.trusted && !signedOut) {
          const t = await staffSignIn(serverUrl);
          if (t) {
            saveToken(t);
            setToken(t);
            return;
          }
        }
        setStatus(s);
      })
      .catch((e: Error) => setError(e.message));
  }, [token, signedOut]);
  useEffect(refreshStatus, [refreshStatus]);

  const signedIn = (t: string) => {
    saveToken(t);
    setToken(t);
  };
  const signOut = async () => {
    await api("/logout", token, { method: "POST" }).catch(() => {});
    setSignedOut(true);
    signedIn("");
  };

  return (
    <main className="admin">
      <BoxAdminLink ctx={venue} />
      <header className="admin-head">
        <h1>Admin</h1>
        <Link to="/" className="muted">
          ← Home
        </Link>
      </header>
      {error && <p className="error">{error}</p>}
      {!status ? (
        <p className="muted">Loading…</p>
      ) : status.authenticated ? (
        <Dashboard token={token} onSignOut={signOut} onExpired={() => signedIn("")} />
      ) : (
        <PasswordForm status={status} onToken={signedIn} />
      )}
    </main>
  );
}

function PasswordForm({ status, onToken }: { status: AdminStatus; onToken: (t: string) => void }) {
  const setupNeeded = status.setupNeeded;
  // On a venue box the box's admin password signs in here too (kit 0.5.1); only staff the
  // box vouches for may set a separate password. Standalone this is always false.
  const onBox = status.venueLogin === true;
  const canSetOwn = onBox && setupNeeded && status.setupAllowed === true;
  const [ownPassword, setOwnPassword] = useState(false);
  const setup = setupNeeded && (!onBox || (canSetOwn && ownPassword));
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (setup && password !== confirm) return setError("The passwords don't match.");
    setBusy(true);
    setError("");
    try {
      const r = await api<{ token: string }>(setup ? "/setup" : "/login", "", { method: "POST", body: { password } });
      onToken(r.token);
    } catch (err) {
      const msg = (err as Error).message;
      setError(onBox && setupNeeded && !setup && /set up/i.test(msg) ? "That isn't the venue's admin password." : msg);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="panel admin-login" onSubmit={submit}>
      <h2>{setup ? "Set the admin password" : "Sign in"}</h2>
      {onBox && !setup && <p className="muted small">{setupNeeded ? "Use the venue's admin password." : "Use this game's admin password, or the venue's admin password."}</p>}
      {setup && (
        <p className="warning">
          No admin password has been set yet. Whoever sets it first becomes the admin, so do this now. The <code>ADMIN_PASSWORD</code> environment variable overrides it.
        </p>
      )}
      <label>
        Password
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={setup ? "new-password" : "current-password"} autoFocus />
      </label>
      {setup && (
        <label>
          Confirm password
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        </label>
      )}
      {error && <p className="error">{error}</p>}
      <button className="btn btn-primary btn-big" disabled={busy || password.length === 0}>
        {setup ? "Set password" : "Sign in"}
      </button>
      {canSetOwn && (
        <button type="button" className="btn btn-ghost" onClick={() => setOwnPassword(!ownPassword)}>
          {ownPassword ? "Sign in with the venue's password instead" : "Set a separate password for this game instead"}
        </button>
      )}
    </form>
  );
}

function Dashboard({ token, onSignOut, onExpired }: { token: string; onSignOut: () => void; onExpired: () => void }) {
  const [data, setData] = useState<AdminOverview | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [idle, setIdle] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await api<AdminOverview>("/overview", token));
    } catch (err) {
      if ((err as { status?: number }).status === 401) onExpired();
      else setError((err as Error).message);
    }
  }, [token, onExpired]);
  useEffect(() => {
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => {
    if (data && idle === "") setIdle(String(data.settings.roomIdleMinutes));
  }, [data, idle]);

  const run = async (fn: () => Promise<string | void>) => {
    setError("");
    setNote("");
    try {
      const msg = await fn();
      if (msg) setNote(msg);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  if (!data) return <p className="muted">Loading…</p>;
  const d = data.settings.roomDefaults;
  const setDefaults = (patch: Partial<RoomSettings>) => run(async () => void (await api("/settings", token, { method: "PUT", body: { roomDefaults: patch } })));

  return (
    <div className="dashboard">
      {error && <p className="error">{error}</p>}
      {note && <p className="note">{note}</p>}

      <section className="panel">
        <h2>Rooms ({data.rooms.length})</h2>
        {data.rooms.length === 0 ? (
          <p className="muted">No rooms open.</p>
        ) : (
          <table className="rooms-table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Host</th>
                <th>Phase</th>
                <th>Players</th>
                <th>Last activity</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.rooms.map((r) => (
                <tr key={r.code}>
                  <td className="mono">{r.code}</td>
                  <td>{r.hostName}</td>
                  <td>
                    {r.phase}
                    {r.round ? ` (round ${r.round})` : ""}
                  </td>
                  <td>
                    {r.players}
                    {r.writers ? ` (${r.writers} writing)` : ""}
                    {r.tables ? ` + ${r.tables} TV` : ""}
                  </td>
                  <td>{ago(data.serverTime - r.lastActivityAt)}</td>
                  <td>
                    <button className="link-btn" onClick={() => window.confirm(`Close room ${r.code}?`) && void run(async () => void (await api(`/rooms/${r.code}/close`, token, { method: "POST" })))}>
                      Close
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel settings">
        <h2>New rooms start with</h2>
        <label className="row">
          <span>
            Writer limit
            <small className="muted">The most writers a game can have (hosts choose up to this). Everyone past it joins the audience. More writers means more face-offs: a round has one per writer.</small>
          </span>
          <select value={data.settings.writerLimit} onChange={(e) => void run(async () => void (await api("/settings", token, { method: "PUT", body: { writerLimit: Number(e.target.value) } })))}>
            {Array.from({ length: WRITER_LIMIT.max - WRITER_LIMIT.min + 1 }, (_, i) => i + WRITER_LIMIT.min).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="row">
          <span>Writers per game</span>
          <select value={d.maxWriters} onChange={(e) => void setDefaults({ maxWriters: Number(e.target.value) })}>
            {Array.from({ length: data.settings.writerLimit - 2 }, (_, i) => i + 3).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="row">
          <span>Prompts</span>
          <select value={d.rating} onChange={(e) => void setDefaults({ rating: e.target.value as Rating })}>
            <option value="family">Family friendly</option>
            <option value="spicy">Spicy only</option>
            <option value="both">Family and spicy</option>
          </select>
        </label>
        <label className="row">
          <span>Writing time</span>
          <select value={d.writeSeconds} onChange={(e) => void setDefaults({ writeSeconds: Number(e.target.value) })}>
            {[...new Set([...WRITE_CHOICES, d.writeSeconds])].sort((x, y) => x - y).map((t) => (
              <option key={t} value={t}>
                {t} seconds
              </option>
            ))}
          </select>
        </label>
        <label className="row">
          <span>Voting time</span>
          <select value={d.voteSeconds} onChange={(e) => void setDefaults({ voteSeconds: Number(e.target.value) })}>
            {[...new Set([...VOTE_CHOICES, d.voteSeconds])].sort((x, y) => x - y).map((t) => (
              <option key={t} value={t}>
                {t} seconds
              </option>
            ))}
          </select>
        </label>
        <label className="row">
          <span>After a reveal</span>
          <select value={d.autoNextSeconds} onChange={(e) => void setDefaults({ autoNextSeconds: Number(e.target.value) })}>
            {[...new Set([...AUTO_NEXT_CHOICES, d.autoNextSeconds])].sort((x, y) => x - y).map((n) => (
              <option key={n} value={n}>
                {n === 0 ? "Wait for Next" : `Next by itself after ${n} s`}
              </option>
            ))}
          </select>
        </label>
        <label className="row check">
          <input type="checkbox" checked={d.filter} onChange={(e) => void setDefaults({ filter: e.target.checked })} />
          <span>Swear filter</span>
        </label>
        <label className="row check">
          <input type="checkbox" checked={d.check} onChange={(e) => void setDefaults({ check: e.target.checked })} />
          <span>Host checks answers before the TV</span>
        </label>
        <fieldset className="packs">
          <legend>Packs</legend>
          {data.packs.map((p) => (
            <label key={p.id} className="row check">
              <input
                type="checkbox"
                checked={d.packIds.includes(p.id)}
                onChange={(e) => void setDefaults({ packIds: e.target.checked ? [...d.packIds, p.id] : d.packIds.filter((x) => x !== p.id) })}
              />
              <span>
                {p.name}{" "}
                <small className="muted">
                  ({p.family} family, {p.spicy} spicy)
                </small>
              </span>
            </label>
          ))}
        </fieldset>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api("/settings", token, { method: "PUT", body: { roomIdleMinutes: Number(idle) } });
              return "Saved.";
            });
          }}
        >
          <span>Close rooms idle for</span>
          <input className="num" type="number" min={5} value={idle} onChange={(e) => setIdle(e.target.value)} /> minutes
          <button className="btn btn-ghost">Save</button>
        </form>
      </section>

      <PacksPanel data={data} token={token} run={run} />

      <button className="btn btn-ghost" onClick={onSignOut}>
        Sign out
      </button>
    </div>
  );
}

type Run = (fn: () => Promise<string | void>) => Promise<void>;

function PacksPanel({ data, token, run }: { data: AdminOverview; token: string; run: Run }) {
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const upload = (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    void run(async () => {
      const text = await file.text();
      const r = await api<{ pack: { name: string; family: number; spicy: number; standIns: number }; warnings: string[] }>("/upload/pack", token, { raw: text, query: { name, file: file.name } });
      setWarnings(r.warnings);
      setName("");
      setFile(null);
      return `Added "${r.pack.name}": ${r.pack.family} family and ${r.pack.spicy} spicy prompts, ${r.pack.standIns} stand-ins.`;
    });
  };
  return (
    <section className="panel">
      <h2>Prompt packs</h2>
      <ul className="pack-list">
        {data.packs.map((p) => (
          <li key={p.id}>
            <span>
              {p.name}{" "}
              <small className="muted">
                ({p.family} family, {p.spicy} spicy, {p.standIns} stand-ins)
              </small>
            </span>
            {p.builtIn ? (
              <small className="muted">built in</small>
            ) : (
              <button className="link-btn" onClick={() => window.confirm(`Delete "${p.name}"?`) && void run(async () => void (await api(`/packs/${p.id}`, token, { method: "DELETE" })))}>
                Delete
              </button>
            )}
          </li>
        ))}
      </ul>
      <form className="upload" onSubmit={upload}>
        <h3>Upload a pack (CSV or JSON)</h3>
        <input value={name} onChange={(e) => setName(e.target.value.slice(0, 40))} placeholder="Pack name (optional)" />
        <input type="file" accept=".csv,.json,.txt,.tsv,text/csv,application/json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <button className="btn btn-secondary" disabled={!file}>
          Upload
        </button>
      </form>
      {warnings.length > 0 && (
        <details open>
          <summary className="muted small">{warnings.length} notes from the upload</summary>
          <ul className="small">
            {warnings.slice(0, 30).map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      )}
      <details>
        <summary className="muted small">File format</summary>
        <div className="small format-help">
          <p>
            <strong>CSV:</strong> a header row with <code>prompt</code> and optionally <code>tag</code> (<code>family</code> or <code>spicy</code>; blank means family) and <code>standin</code>: a short, safe joke used when someone doesn't answer (a row can hold just a stand-in). Without a header the columns are prompt, tag.
          </p>
          <pre>{`prompt,tag,standin
The worst thing to hear at a car wash,family,A very wet llama
A cocktail that should be illegal,spicy,
,,Grandma's secret recipe`}</pre>
          <p>
            <strong>JSON:</strong> a list of prompts, or <code>{`{ "name": "…", "prompts": [...], "standIns": [...] }`}</code>:
          </p>
          <pre>{`{ "name": "Friday night",
  "prompts": ["The worst thing to hear at a car wash",
              { "prompt": "A cocktail that should be illegal", "tag": "spicy" }],
  "standIns": ["A very wet llama"] }`}</pre>
          <p>
            Full examples: <code>examples/pack-example.csv</code> and <code>examples/pack-example.json</code> in the game's repository.
          </p>
        </div>
      </details>
    </section>
  );
}
