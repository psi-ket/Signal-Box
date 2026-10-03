import { useEffect, useRef, useState } from "react";
import { roleAtLeast, type Role, type RoomState, type VoteView } from "../../../shared/protocol.ts";

const LINGER_MS = 7000;

const REASON_TEXT: Record<string, string> = {
  majority: "Majority vote",
  owner_decision: "Owner decided",
  owner_tiebreak: "Owner broke the tie",
  owner_no_votes: "Owner decided (no votes)",
  fallback_owner_absent: "No decision: owner offline",
  fallback_owner_timeout: "No decision: owner didn't choose in time",
  session_cancelled: "Session cancelled",
};

function chime() {
  try {
    const ctx = new AudioContext();
    const now = ctx.currentTime;
    for (const [i, f] of [660, 880].entries()) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, now + i * 0.14);
      g.gain.exponentialRampToValueAtTime(0.15, now + i * 0.14 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.14 + 0.35);
      o.connect(g).connect(ctx.destination);
      o.start(now + i * 0.14);
      o.stop(now + i * 0.14 + 0.4);
    }
    setTimeout(() => void ctx.close(), 1000);
  } catch {
    /* audio unavailable */
  }
}

function VoteCard(props: { v: VoteView; state: RoomState; meId: string; myRole: Role; mine?: string; now: number; onVote: (o: string) => void; onResolve: (o: string) => void }) {
  const { v, state, meId, mine, now } = props;
  const mayVote = v.audience === "owner" ? v.ownerId === meId : roleAtLeast(props.myRole, "voter");
  const session = state.sessions[v.sessionId];
  const isOwner = session?.ownerId === meId;
  const total = Object.values(v.counts).reduce((a, b) => a + b, 0);
  const deadline = v.phase === "awaiting_owner" ? v.ownerDeadline ?? v.deadline : v.deadline;
  const span = v.phase === "awaiting_owner" ? (v.ownerDeadline ?? 0) - v.deadline : v.deadline - v.openedAt;
  const left = Math.max(0, deadline - now);
  const frac = span > 0 ? Math.min(1, left / span) : 0;
  const done = v.phase === "resolved" || v.phase === "cancelled";
  const winner = v.options.find((o) => o.id === v.resolvedOptionId);

  return (
    <section className={`ballot ballot--${v.phase} ballot--${v.kind}`} role="dialog" aria-label={`${v.kind === "permission" ? "Permission request" : "Team decision"}: ${v.question}`}>
      <header className="ballot__head">
        <span className="ballot__plate">{v.kind === "permission" ? "permission · only you decide" : v.header}</span>
        <span className="ballot__from">{session?.title ?? "session"} · {session?.ownerName}</span>
        {!done && <span className="ballot__clock" aria-label={`${Math.ceil(left / 1000)} seconds left`}>{Math.ceil(left / 1000)}s</span>}
      </header>
      {!done && <div className="ballot__fuse" style={{ transform: `scaleX(${frac})` }} aria-hidden />}
      <h3 className="ballot__q">{v.question}</h3>
      {v.detail && <p className="ballot__detail">{v.detail}</p>}

      <ul className="ballot__opts">
        {v.options.map((o) => {
          const n = v.counts[o.id] ?? 0;
          const pct = total ? (n / total) * 100 : 0;
          const canVote = v.phase === "open" && !mine && mayVote;
          const canResolve = v.phase === "awaiting_owner" && isOwner;
          return (
            <li key={o.id}>
              <button
                className={`opt${mine === o.id ? " opt--mine" : ""}${winner?.id === o.id ? " opt--won" : ""}`}
                disabled={!(canVote || canResolve)}
                onClick={() => (canResolve ? props.onResolve(o.id) : props.onVote(o.id))}
              >
                <span className="opt__bar" style={{ width: `${pct}%` }} aria-hidden />
                <span className="opt__label">{o.label}</span>
                {o.description && <span className="opt__desc">{o.description}</span>}
                <span className="opt__n">{n}</span>
              </button>
            </li>
          );
        })}
      </ul>

      <p className="ballot__foot">
        {v.phase === "open" && v.audience === "owner" && "No answer by the deadline means deny."}
        {v.phase === "open" && v.audience === "team" && !mayVote && `You are watching (${props.myRole}). ${v.voterCount} vote${v.voterCount === 1 ? "" : "s"} in.`}
        {v.phase === "open" && v.audience === "team" && mayVote && (mine ? `You voted ${v.options.find((o) => o.id === mine)?.label}. ${v.voterCount} vote${v.voterCount === 1 ? "" : "s"} in.` : `${v.voterCount} vote${v.voterCount === 1 ? "" : "s"} in. Highest count wins; ties go to the owner.`)}
        {v.phase === "awaiting_owner" && (isOwner ? (total ? "Tied. Pick the winner." : "Nobody voted. Pick an option.") : `Waiting for ${session?.ownerName} to decide.`)}
        {done && (
          <>
            <b>{winner ? winner.label : v.phase === "cancelled" ? "Cancelled" : v.kind === "permission" ? "Denied" : "No decision"}</b> · {REASON_TEXT[v.resolution ?? ""] ?? ""}
          </>
        )}
      </p>
    </section>
  );
}

export function VoteDock(props: { state: RoomState; meId: string; myRole: Role; myVotes: Record<string, string>; now: number; onVote: (v: string, o: string) => void; onResolve: (v: string, o: string) => void }) {
  const { state, now } = props;
  const [muted, setMuted] = useState(() => {
    try {
      return localStorage.getItem("colab.muted") === "1";
    } catch {
      return false;
    }
  });
  const seen = useRef<Set<string> | null>(null);

  const votes = Object.values(state.votes)
    .filter((v) => v.audience === "team" || v.ownerId === props.meId)
    .filter((v) => v.phase === "open" || v.phase === "awaiting_owner" || (v.resolvedAt !== null && now - v.resolvedAt < LINGER_MS))
    .sort((a, b) => a.openedAt - b.openedAt);

  useEffect(() => {
    const open = Object.values(state.votes).filter((v) => v.phase === "open" && (v.audience === "team" || v.ownerId === props.meId)).map((v) => v.id);
    if (seen.current === null) {
      seen.current = new Set(Object.keys(state.votes)); // don't chime for votes that predate this page load
      return;
    }
    const fresh = open.filter((id) => !seen.current!.has(id));
    for (const id of Object.keys(state.votes)) seen.current.add(id);
    if (fresh.length && !muted) chime();
  }, [state.votes, muted, props.meId]);

  if (votes.length === 0) return null;
  return (
    <aside className="dock" aria-label="Team decisions">
      <button
        className="dock__mute ghost"
        onClick={() => {
          setMuted(!muted);
          try {
            localStorage.setItem("colab.muted", muted ? "0" : "1");
          } catch {
            /* ignore */
          }
        }}
      >
        {muted ? "sound: off" : "sound: on"}
      </button>
      {votes.map((v) => (
        <VoteCard key={v.id} v={v} state={state} meId={props.meId} myRole={props.myRole} mine={props.myVotes[v.id]} now={now} onVote={(o) => props.onVote(v.id, o)} onResolve={(o) => props.onResolve(v.id, o)} />
      ))}
    </aside>
  );
}
