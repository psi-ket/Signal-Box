import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { roleAtLeast, type Participant } from "../../shared/protocol.ts";
import { api, type User } from "./api.ts";
import { Auth } from "./components/Auth.tsx";
import { Chat } from "./components/Chat.tsx";
import { Keys } from "./components/Keys.tsx";
import { Landing } from "./components/Landing.tsx";
import { Lobby } from "./components/Lobby.tsx";
import { NewSession } from "./components/NewSession.tsx";
import { People } from "./components/People.tsx";
import { Recap } from "./components/Recap.tsx";
import { SessionPane } from "./components/SessionPane.tsx";
import { SignalStrip } from "./components/SignalStrip.tsx";
import { VoteDock } from "./components/VoteDock.tsx";
import { linkProps, navigate, usePath } from "./router.ts";
import { useSite, type ConnStatus, type Site } from "./useSite.ts";

function useNow(offset: number, ms = 500) {
  const [now, setNow] = useState(() => Date.now() + offset);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() + offset), ms);
    return () => clearInterval(t);
  }, [offset, ms]);
  return now;
}

const CONN_TEXT: Record<ConnStatus, string> = {
  connecting: "connecting",
  open: "live",
  reconnecting: "reconnecting",
  signed_out: "signed out",
};

function Gate({ children }: { children: React.ReactNode }) {
  return (
    <main className="gate">
      <div className="box gate__card">{children}</div>
    </main>
  );
}

export function App() {
  const path = usePath();
  const [user, setUser] = useState<User | null | undefined>(undefined);
  useEffect(() => {
    api.me().then(
      (r) => setUser(r.user),
      () => setUser(null),
    );
  }, []);

  // Redirects happen in an effect, never during render.
  const redirect = user === undefined ? null : (path === "/login" || path === "/register") && user ? "/rooms" : path.startsWith("/rooms") && !user ? `/login?next=${encodeURIComponent(path)}` : null;
  useEffect(() => {
    if (redirect) navigate(redirect, { replace: true });
  }, [redirect]);

  if (user === undefined || redirect) return <Gate>loading…</Gate>;
  if (path === "/login" || path === "/register") return <Auth mode={path === "/login" ? "login" : "register"} onAuthed={setUser} />;
  if (!path.startsWith("/rooms") || !user) return <Landing user={user} />;
  return (
    <Site
      key={user.id}
      onSignedOut={() => {
        setUser(null);
        navigate(`/login?next=${encodeURIComponent(location.pathname)}`, { replace: true });
      }}
      onLogout={async () => {
        await api.logout().catch(() => {});
        setUser(null);
        navigate("/", { replace: true });
      }}
    />
  );
}

function Site({ onSignedOut, onLogout }: { onSignedOut: () => void; onLogout: () => void }) {
  const site = useSite(true);
  const path = usePath();
  const now = useNow(site.clockOffset);
  const roomId = /^\/rooms\/([\w-]+)/.exec(path)?.[1] ?? null;

  useEffect(() => {
    if (site.status === "signed_out") onSignedOut();
  }, [site.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the URL and the joined room in sync.
  useEffect(() => {
    if (site.room && site.room.roomId !== roomId) navigate(`/rooms/${site.room.roomId}`, { replace: !roomId });
  }, [site.room?.roomId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!roomId && site.room) site.leaveRoom();
  }, [roomId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!site.me) return <Gate>{`${CONN_TEXT[site.status]}…`}</Gate>;

  return (
    <>
      {site.status !== "open" && <p className="banner">connection lost; reconnecting. What you see may be out of date.</p>}
      {roomId ? site.room?.roomId === roomId ? <RoomView site={site} now={now} /> : <JoinRoom key={roomId} site={site} roomId={roomId} /> : <Lobby site={site} now={now} onLogout={onLogout} />}
      <div className="toasts" aria-live="assertive">
        {site.toasts.map((t) => (
          <p key={t.id} className={`toast toast--${t.tone}`}>
            {t.tone === "error" ? "error: " : ""}
            {t.text}
          </p>
        ))}
      </div>
    </>
  );
}

/** Joins the room in the URL; asks for the password if the room has one. */
function JoinRoom({ site, roomId }: { site: Site; roomId: string }) {
  const summary = site.rooms.find((r) => r.id === roomId);
  const [pw, setPw] = useState("");
  const [needPw, setNeedPw] = useState(false);
  const tried = useRef(false);
  const since = useRef(Date.now());

  useEffect(() => {
    if (site.status !== "open" || tried.current) return;
    tried.current = true;
    site.joinRoom(roomId);
  }, [site.status, roomId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const e = site.lastError;
    if (!e || e.at < since.current) return;
    if (e.code === "bad_password") {
      setNeedPw(true);
      setPw("");
    } else if (["not_found", "room_full", "forbidden"].includes(e.code)) navigate("/rooms", { replace: true });
  }, [site.lastError]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (pw) site.joinRoom(roomId, pw);
  };

  return (
    <Gate>
      <h1 className="box__title">{summary?.name ?? "room"}</h1>
      {needPw ? (
        <form className="pw pw--big" onSubmit={submit}>
          <p className="muted">This room needs a password.</p>
          <label className="sr-only" htmlFor="room-pw">
            Room password
          </label>
          <input id="room-pw" type="password" value={pw} autoFocus onChange={(e) => setPw(e.target.value)} autoComplete="current-password" />
          <button type="submit" disabled={!pw}>
            enter room
          </button>
        </form>
      ) : (
        <p className="muted">joining…</p>
      )}
      <p>
        <a {...linkProps("/rooms")} className="ghost-link">
          back to rooms
        </a>
      </p>
    </Gate>
  );
}

function RoomView({ site, now }: { site: Site; now: number }) {
  const state = site.room!;
  const me = site.me!;
  const { send } = site;
  const myRole = state.participants[me.id]?.role ?? "viewer";
  const [showRecap, setShowRecap] = useState(true);
  const [confirm, setConfirm] = useState<"end" | "close" | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [tab, setTab] = useState<"chat" | "people" | "keys">("chat");
  const [sideOpen, setSideOpen] = useState(() => {
    try {
      return localStorage.getItem("colab.sidebar") !== "closed";
    } catch {
      return true;
    }
  });
  const seenChat = useRef(state.chat.length);
  if (sideOpen && tab === "chat") seenChat.current = state.chat.length;
  const unread = state.chat.slice(seenChat.current).filter((m) => m.kind === "user").length;
  const toggleSide = () => {
    const next = !sideOpen;
    setSideOpen(next);
    try {
      localStorage.setItem("colab.sidebar", next ? "open" : "closed");
    } catch {
      /* ignore */
    }
  };

  const myRunner = Object.values(state.runners).find((r) => r.ownerId === me.id) ?? Object.values(state.runners).find((r) => r.shared);

  const viewersBySession = useMemo(() => {
    const out: Record<string, Participant[]> = {};
    for (const p of Object.values(state.participants)) if (p.online && p.viewingSessionId && p.id !== me.id) (out[p.viewingSessionId] ??= []).push(p);
    return out;
  }, [state.participants, me.id]);

  const focus = (id: string) => {
    if (focused === id) return;
    setFocused(id);
    send("presence", { viewingSessionId: id });
  };

  const online = Object.values(state.participants).filter((p) => p.online).length;
  const isAdmin = myRole === "admin";
  const canEdit = roleAtLeast(myRole, "editor");
  const runnerCount = Object.keys(state.runners).length;

  return (
    <div className="app">
      <header className="top">
        <a {...linkProps("/rooms")} className="ghost-link small" title="back to the room list">
          ← rooms
        </a>
        <p className="top__path">
          <span className="ps1">{me.username}@signalbox</span>:<span className="cwd">~/{state.name}</span>
          <span className="muted">
            {" "}
            · {state.repoName}@{state.baseRef}
          </span>
        </p>
        <span className={`tag tag--${myRole}`}>{myRole}</span>
        <p className={`conn conn--${site.status}`} role="status">
          <span className="conn__dot" /> {CONN_TEXT[site.status]}
        </p>
        <p className="muted">
          {online}/{state.settings.maxPeople} online · {runnerCount} runner{runnerCount === 1 ? "" : "s"}
        </p>
        {isAdmin &&
          (confirm ? (
            <>
              <button className="danger" onClick={() => (send(confirm === "end" ? "room.end" : "room.close", {}), setConfirm(null))}>
                {confirm === "end" ? "confirm: stop agents + recap" : "confirm: close room for everyone"}
              </button>
              <button className="ghost small" onClick={() => setConfirm(null)}>
                no
              </button>
            </>
          ) : (
            <>
              {!state.ended && (
                <button className="ghost" onClick={() => setConfirm("end")}>
                  end room
                </button>
              )}
              <button className="ghost" onClick={() => setConfirm("close")}>
                close room
              </button>
            </>
          ))}
        <button className="ghost" onClick={toggleSide} aria-expanded={sideOpen} aria-controls="side" title={sideOpen ? "hide the side panel" : "show the side panel"}>
          {sideOpen ? "hide panel" : unread ? `panel · ${unread} new` : "panel"}
        </button>
        {state.recap && !showRecap && (
          <button className="ghost" onClick={() => setShowRecap(true)}>
            recap
          </button>
        )}
      </header>
      {state.ended && <p className="banner banner--info">room ended. agents are stopped; their branches stay on each runner.</p>}

      <SignalStrip state={state} now={now} />

      <div className={sideOpen ? "body" : "body body--wide"}>
        <main className="grid" aria-label="Agent sessions">
          {state.sessionOrder.length === 0 && (
            <div className="grid__empty">
              <p>
                <span className="ps1">$</span> no agents running
              </p>
              <p className="muted">
                {canEdit
                  ? myRunner
                    ? "Spawn one from the panel. It runs on your runner, on its own branch; its design questions come to everyone here as a vote."
                    : "Connect a runner (rooms page → your runners) to start agents on your machine."
                  : `You joined as ${myRole}. Editors start agents; you can watch${roleAtLeast(myRole, "voter") ? ", vote" : ""} and chat.`}
              </p>
            </div>
          )}
          {state.sessionOrder.map((id) => (
            <SessionPane
              key={id}
              session={state.sessions[id]!}
              now={now}
              meId={me.id}
              isHost={isAdmin}
              canEdit={canEdit}
              viewers={viewersBySession[id] ?? []}
              onFocus={() => focus(id)}
              onPrompt={(text) => send("session.prompt", { sessionId: id, text })}
              onCancel={() => send("session.cancel", { sessionId: id })}
              onEnd={() => send("session.end", { sessionId: id })}
            />
          ))}
        </main>

        <aside className="side" id="side" hidden={!sideOpen}>
          {!state.ended && canEdit && (
            <NewSession
              state={state}
              runner={myRunner}
              myKeys={site.myKeys}
              onManageKeys={() => setTab("keys")}
              onCreate={(title, task, provider, model, ownKey) => send("session.create", { title, task, provider, ...(model ? { model } : {}), ...(ownKey ? { ownKey } : {}) })}
            />
          )}
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === "chat"} className={tab === "chat" ? "tab tab--on" : "tab"} onClick={() => setTab("chat")}>
              chat
            </button>
            <button role="tab" aria-selected={tab === "people"} className={tab === "people" ? "tab tab--on" : "tab"} onClick={() => setTab("people")}>
              people ({online})
            </button>
            <button role="tab" aria-selected={tab === "keys"} className={tab === "keys" ? "tab tab--on" : "tab"} onClick={() => setTab("keys")}>
              keys{site.myKeys.length ? ` (${site.myKeys.length})` : ""}
            </button>
          </div>
          {tab === "keys" ? (
            <Keys myKeys={site.myKeys} keyResult={site.keyResult} send={send} disabled={!myRunner} />
          ) : tab === "chat" ? (
            <Chat messages={state.chat} meId={me.id} onSend={(text) => send("chat.send", { text })} />
          ) : (
            <People
              state={state}
              meId={me.id}
              myRole={myRole}
              onRole={(participantId, role) => send("member.role", { participantId, role })}
              onKick={(participantId) => send("member.kick", { participantId })}
            />
          )}
        </aside>
      </div>

      <VoteDock
        state={state}
        meId={me.id}
        myRole={myRole}
        myVotes={site.myVotes}
        now={now}
        onVote={(voteId, optionId) => send("vote.cast", { voteId, optionId })}
        onResolve={(voteId, optionId) => send("vote.resolve", { voteId, optionId })}
      />

      {state.recap && showRecap && <Recap recap={state.recap} onClose={() => setShowRecap(false)} />}
    </div>
  );
}
