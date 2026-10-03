import { memo, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Participant, SessionView, TranscriptItem } from "../../../shared/protocol.ts";

const STATUS_TEXT: Record<SessionView["status"], string> = {
  starting: "Starting",
  running: "Working",
  waiting_vote: "Waiting on a decision",
  idle: "Waiting for a prompt",
  completed: "Ended",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function formatDuration(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}:${String(s % 60).padStart(2, "0")}`;
}

// Agent output is untrusted: no raw HTML (react-markdown default), unsafe URL schemes are
// stripped by its default urlTransform, links open in a new tab, remote images become links.
const MD_COMPONENTS: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  ),
  img: ({ src, alt }) => (
    <a href={typeof src === "string" ? src : undefined} target="_blank" rel="noopener noreferrer nofollow">
      [image: {alt || "untitled"}]
    </a>
  ),
};

export const AgentMarkdown = memo(function AgentMarkdown({ text }: { text: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
      {text}
    </Markdown>
  );
});

const Item = memo(function Item({ item }: { item: TranscriptItem }) {
  switch (item.kind) {
    case "text":
      return (
        <div className={`t-text md${item.streaming ? " t-text--live" : ""}`}>
          <AgentMarkdown text={item.text} />
        </div>
      );
    case "prompt":
      return (
        <p className="t-prompt">
          <span className="t-prompt__by">{item.by}</span>
          {item.text}
        </p>
      );
    case "tool_call":
      return (
        <details className={`t-tool t-tool--${item.status}`}>
          <summary>
            <span className="t-tool__name">{item.tool}</span>
            <span className="t-tool__sum">{item.summary}</span>
            <span className="t-tool__st">{item.status === "pending" ? "…" : item.status}</span>
          </summary>
          {item.result && <pre>{item.result}</pre>}
        </details>
      );
    case "file":
      return (
        <p className="t-file">
          {item.action} <code>{item.path}</code>
        </p>
      );
    case "decision":
      return <p className="t-decision">Team decision: {item.text}</p>;
    case "error":
      return <p className="t-error">{item.message}</p>;
    case "system":
      return <p className="t-system">{item.text}</p>;
  }
});

const Transcript = memo(function Transcript({ items }: { items: TranscriptItem[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [items]);
  return (
    <div
      className="pane__log"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
      aria-live="polite"
      aria-relevant="additions"
    >
      {items.map((i) => (
        <Item key={i.id} item={i} />
      ))}
    </div>
  );
});

export function SessionPane(props: {
  session: SessionView;
  now: number;
  meId: string;
  isHost: boolean;
  canEdit: boolean;
  viewers: Participant[];
  onPrompt: (text: string) => void;
  onCancel: () => void;
  onEnd: () => void;
  onFocus: () => void;
}) {
  const { session: s, now, meId, isHost } = props;
  const [draft, setDraft] = useState("");
  const [confirm, setConfirm] = useState(false);
  const isOwner = s.ownerId === meId;
  const live = !["completed", "failed", "cancelled"].includes(s.status);
  const canPrompt = isOwner && props.canEdit && live && s.status !== "starting";
  const elapsed = s.startedAt ? (s.endedAt ?? now) - s.startedAt : 0;
  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(false), 4000);
    return () => clearTimeout(t);
  }, [confirm]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    props.onPrompt(text);
    setDraft("");
  };

  return (
    <article id={`pane-${s.id}`} className={`pane pane--${s.status}`} onFocusCapture={props.onFocus} onPointerDown={props.onFocus}>
      <header className="pane__head">
        <div className="pane__title">
          <h2>{s.title}</h2>
          <p>
            {s.ownerName}
            {isOwner && " (you)"} · {s.provider}
            {s.model ? `/${s.model}` : ""}
            {s.billing === "own" && <span className="tag tag--own">own key</span>} · <code>{s.branch}</code>
          </p>
        </div>
        <div className="pane__state">
          <span className={`status status--${s.status}`}>{STATUS_TEXT[s.status]}</span>
          <span className="pane__time">{formatDuration(elapsed)}</span>
        </div>
      </header>
      {props.viewers.length > 0 && (
        <p className="pane__viewers" aria-label="Watching this session">
          {props.viewers.map((v) => (
            <span key={v.id} className="chip" title={`${v.name} is watching`}>
              {v.name}
            </span>
          ))}
        </p>
      )}
      {s.error && <p className="pane__error">{s.error}</p>}
      <Transcript items={s.transcript} />
      {s.filesTouched.length > 0 && (
        <p className="pane__files">
          Files: {s.filesTouched.slice(-6).map((f) => <code key={f}>{f}</code>)}
          {s.filesTouched.length > 6 && ` +${s.filesTouched.length - 6}`}
        </p>
      )}
      <footer className="pane__foot">
        {canPrompt ? (
          <form onSubmit={submit} className="prompt">
            <label className="sr-only" htmlFor={`prompt-${s.id}`}>
              Prompt for {s.title}
            </label>
            <input id={`prompt-${s.id}`} value={draft} maxLength={4000} onChange={(e) => setDraft(e.target.value)} placeholder="Tell your agent what to do next" />
            <button type="submit" disabled={!draft.trim()}>
              Send
            </button>
          </form>
        ) : (
          <p className="pane__hint">{live ? (isOwner ? "Agent is starting…" : `Only ${s.ownerName} can prompt this agent.`) : `${STATUS_TEXT[s.status]} after ${s.turns} turn${s.turns === 1 ? "" : "s"}.`}</p>
        )}
        {live && (isOwner || isHost) && (
          <div className="pane__actions">
            <button className="ghost" onClick={props.onEnd} title="Stop the agent and keep its work">
              End
            </button>
            {confirm ? (
              <button className="danger" onClick={props.onCancel}>
                Confirm cancel
              </button>
            ) : (
              <button className="ghost" onClick={() => setConfirm(true)}>
                Cancel
              </button>
            )}
          </div>
        )}
      </footer>
    </article>
  );
}
