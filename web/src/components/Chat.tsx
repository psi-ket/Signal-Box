import { memo, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import type { ChatMessage } from "../../../shared/protocol.ts";

const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Stable per-name hue so people are easy to tell apart. */
const hue = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

export const Chat = memo(function Chat({ messages, meId, onSend }: { messages: ChatMessage[]; meId: string; onSend: (text: string) => void }) {
  const [draft, setDraft] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    if (ref.current && pinned.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [messages]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = draft.trim();
    if (!t) return;
    onSend(t);
    setDraft("");
  };

  return (
    <section className="box chat" aria-label="Room chat">
      <h2 className="box__title">chat</h2>
      <div
        className="chat__log"
        ref={ref}
        aria-live="polite"
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
        }}
      >
        {messages.length === 0 && <p className="muted">No messages yet. Agree on who builds what before starting agents.</p>}
        {messages.map((m) =>
          m.kind === "system" ? (
            <p key={m.id} className="chat__sys">
              <span className="chat__time">{time(m.at)}</span> -- {m.text}
            </p>
          ) : (
            <p key={m.id} className="chat__msg">
              <span className="chat__time">{time(m.at)}</span>{" "}
              <span className="chat__who" style={{ color: `hsl(${hue(m.byName)} 70% 68%)` }}>
                &lt;{m.byName}
                {m.byId === meId ? "*" : ""}&gt;
              </span>{" "}
              {m.text}
            </p>
          ),
        )}
      </div>
      <form className="chat__form" onSubmit={submit}>
        <span className="ps1" aria-hidden>
          &gt;
        </span>
        <label className="sr-only" htmlFor="chat-input">
          Message
        </label>
        <input id="chat-input" value={draft} maxLength={1000} onChange={(e) => setDraft(e.target.value)} placeholder="say something to the room" autoComplete="off" />
      </form>
    </section>
  );
});
