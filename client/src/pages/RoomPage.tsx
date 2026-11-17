import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useOnScreenKeyboard, useRoomConnection } from "@bargames/gamekit/client";
import { isOnBox, markSharedScreen, tableMode, type TableModeController } from "@bargames/sdk/client";
import type { JoinResult, RoomView } from "@zinger/shared";
import { toggleFullscreen } from "../fullscreen";
import { call, socket } from "../socket";
import { clearSession, getBigScreen, loadSession, saveSession, sessions, setBigScreen, type StoredSession } from "../session";
import { useVenue } from "../useVenue";
import { HostView } from "./HostView";
import { PlayerView } from "./PlayerView";
import { TableView } from "./TableView";

/** Runs a server intent, surfacing a rejection as a short-lived toast. */
export function useAction() {
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);
  const act = useCallback(async <T = object,>(event: string, ...args: unknown[]) => {
    try {
      return await call<T>(event, ...args);
    } catch (err) {
      setToast(err instanceof Error ? err.message : "Something went wrong.");
      return null;
    }
  }, []);
  return { act, toast, setToast };
}
export type Act = ReturnType<typeof useAction>["act"];

export function RoomPage() {
  const { code = "" } = useParams();
  const upper = code.toUpperCase();
  const [search] = useSearchParams();
  // The TV route (/room/{code}?role=table): the URL alone joins as a display, no prompts.
  const wantTable = search.get("role") === "table";
  const hasSeat = () => {
    const s = loadSession();
    return !!s && s.roomCode === upper && (!wantTable || s.role === "table");
  };
  const [ready, setReady] = useState(hasSeat);
  if (!ready && wantTable) return <TableJoin code={upper} onJoined={() => setReady(true)} />;
  return <InRoom code={upper} />;
}

/** Joins this screen as the room's TV, retrying quietly (a box TV has nobody to tap Retry). */
function TableJoin({ code, onJoined }: { code: string; onJoined: () => void }) {
  const [error, setError] = useState("");
  const venue = useVenue();
  useEffect(() => (isOnBox(venue) ? markSharedScreen() : undefined), [venue]);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const attempt = () =>
      call<JoinResult>("joinRoom", { code, role: "table" })
        .then((r) => {
          if (!live) return;
          saveSession({ roomCode: r.code, token: r.token, name: r.name, role: r.role });
          onJoined();
        })
        .catch((err: Error) => {
          if (!live) return;
          setError(err.message);
          timer = setTimeout(attempt, 10_000);
        });
    attempt();
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);
  return (
    <main className="center-page tv-wait">
      <p className="muted">{error ? `${error} Trying again…` : `Opening room ${code}…`}</p>
    </main>
  );
}

function InRoom({ code }: { code: string }) {
  const navigate = useNavigate();
  const { view, status, closedReason, skew, reconnect } = useRoomConnection<RoomView, StoredSession>(code, {
    socket: socket as unknown as Parameters<typeof useRoomConnection>[1]["socket"],
    call,
    sessions,
    // The host link's key resumes the host seat and the server answers with the seat's own
    // token: keep it, so a later take-over (a new key) leaves this phone on as a co-host.
    onResumed: (ack, session) =>
      sessions.save({
        ...session,
        token: typeof ack.token === "string" ? ack.token : session.token,
        name: typeof ack.name === "string" ? ack.name : session.name,
        role: typeof ack.role === "string" ? (ack.role as StoredSession["role"]) : session.role,
      }),
  });
  const { act, toast, setToast } = useAction();
  // An on-screen keyboard covers the bottom of the screen: show toasts at the top there.
  const keyboard = useOnScreenKeyboard();
  useEffect(() => {
    const onNotice = (n: { message: string }) => setToast(n.message);
    socket.on("notice", onNotice);
    return () => {
      socket.off("notice", onNotice);
    };
  }, [setToast]);
  const [bigScreen, setBig] = useState(() => getBigScreen(code));
  const showBig = (on: boolean) => {
    setBigScreen(code, on);
    setBig(on);
    window.scrollTo(0, 0);
  };

  // A box TV: the SDK's tableMode hides the pointer, keeps the screen awake, sets the safe
  // margins (--bg-safe-x/y) and shows the standard reconnecting / room closed banner. It
  // also marks the page as a shared screen. Off a box nothing changes.
  const venue = useVenue();
  const role = view?.you.role;
  const onBox = isOnBox(venue);
  const boxTv = onBox && role === "table";
  const tm = useRef<TableModeController | null>(null);
  useEffect(() => {
    if (!boxTv) return;
    tm.current = tableMode(venue);
    return () => {
      tm.current?.stop();
      tm.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxTv]);
  useEffect(() => {
    tm.current?.setState(closedReason ? "closed" : status === "offline" ? "reconnecting" : "connected", closedReason ?? undefined);
  }, [boxTv, status, closedReason]);
  const runner = role === "host" || role === "cohost";
  // The host's own big screen on a box is a shared screen too (the phone strip hides there).
  const sharedScreen = onBox && runner && bigScreen;
  useEffect(() => (sharedScreen ? markSharedScreen() : undefined), [sharedScreen]);

  if (closedReason) {
    return (
      <main className={`center-page ${role === "table" ? "tv-wait" : ""}`}>
        <div className="panel">
          <h2>Room closed</h2>
          <p>{closedReason}</p>
          {role !== "table" && (
            <Link className="btn btn-primary" to="/">
              Back to home
            </Link>
          )}
        </div>
      </main>
    );
  }
  if (!view) {
    return (
      <main className={`center-page ${role === "table" ? "tv-wait" : ""}`}>
        <p className="muted">Connecting to room {code}…</p>
      </main>
    );
  }

  const leave = async () => {
    if (!window.confirm(role === "host" ? "End this room for everyone?" : "Leave this room?")) return;
    await call("leaveRoom").catch(() => {});
    clearSession();
    navigate("/");
  };
  const fullScreen = role === "table" || (runner && bigScreen);

  return (
    <div className={`room role-${role}`}>
      {status !== "online" && !boxTv && (
        <div className={`banner ${fullScreen ? "banner-float" : ""}`} role="status">
          {status === "offline" ? "Connection lost. Reconnecting…" : "Connecting…"}
        </div>
      )}
      {!fullScreen && (
        <header className="room-header">
          <div className="room-id">
            <span className="room-code">{view.code}</span>
            <span className="muted">{role === "host" ? "Host" : view.you.name}</span>
            {role === "cohost" && <span className="badge">Co-host</span>}
          </div>
          <div className="header-actions">
            {runner && (
              <button className="icon-btn" onClick={() => showBig(true)} title="Show the TV view here" aria-label="Show the TV view here">
                📺
              </button>
            )}
            <button className="icon-btn" onClick={toggleFullscreen} title="Full screen" aria-label="Full screen">
              ⛶
            </button>
            <button className="icon-btn" onClick={reconnect} title="Reconnect" aria-label="Reconnect">
              ⟳
            </button>
            <button className="icon-btn" onClick={leave} title={role === "host" ? "End room" : "Leave"} aria-label="Leave">
              ✕
            </button>
          </div>
        </header>
      )}
      {runner && !bigScreen && <HostView view={view} skew={skew} act={act} />}
      {runner && bigScreen && <TableView view={view} skew={skew} act={act} onHostControls={() => showBig(false)} />}
      {role === "player" && <PlayerView view={view} skew={skew} act={act} />}
      {role === "table" && <TableView view={view} skew={skew} act={act} boxTv={boxTv} />}
      {toast && (
        <div className={`toast${keyboard ? " toast-top" : ""}`} role="alert" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
    </div>
  );
}
