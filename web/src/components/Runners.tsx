import { useEffect, useState, type FormEvent } from "react";
import type { RunnerView } from "../../../shared/protocol.ts";
import { api, type RunnerToken } from "../api.ts";

const ago = (t: number | null) => {
  if (!t) return "never";
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};

/** Your runners: create a token (shown once, with the exact command), see which are online, revoke. */
export function Runners({ online, meId }: { online: RunnerView[]; meId: string }) {
  const [tokens, setTokens] = useState<RunnerToken[]>([]);
  const [name, setName] = useState("my laptop");
  const [fresh, setFresh] = useState<{ name: string; token: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = () => api.runners().then((r) => setTokens(r.runners), (e: Error) => setError(e.message));
  useEffect(() => void load(), []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const r = await api.createRunner(name.trim());
      setFresh({ name: r.name, token: r.token });
      setCopied(false);
      void load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const revoke = async (id: string) => {
    try {
      await api.revokeRunner(id);
      void load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const mine = online.filter((r) => r.ownerId === meId);
  const shared = online.find((r) => r.shared);
  const command = fresh ? `npm run runner -- --hub ${location.origin} --token ${fresh.token}` : "";

  return (
    <section className="box runners">
      <h2 className="box__title">your runners</h2>
      <p className="muted small">
        A runner is a small process on your own machine. It clones the room's repo with your Git access and runs your agents with your logins or keys. The hub never runs code.
      </p>
      <p>
        {mine.length ? (
          mine.map((r) => (
            <span key={r.id} className="runner-on">
              <span className="ok">●</span> {r.name} <span className="muted">online · {r.providers.filter((p) => p.available || p.byoReady).length} agents</span>
            </span>
          ))
        ) : (
          <span className="off">○ no runner online</span>
        )}
        {shared && !mine.length && <span className="muted small"> · the shared host runner is available for your agents</span>}
      </p>

      {fresh ? (
        <div className="fresh">
          <p className="warn">Copy this now. The token is shown only once and works like a password for your runner.</p>
          <p className="muted small">In a checkout of Signal Box (git clone, then npm install), run:</p>
          <pre className="cmd">{command}</pre>
          <p>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(command).then(() => setCopied(true));
              }}
            >
              {copied ? "copied" : "copy command"}
            </button>{" "}
            <button type="button" className="ghost small" onClick={() => setFresh(null)}>
              done
            </button>
          </p>
        </div>
      ) : (
        <form className="runner-new" onSubmit={create}>
          <label className="sr-only" htmlFor="runner-name">
            Runner name
          </label>
          <input id="runner-name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="my laptop" />
          <button type="submit" disabled={!name.trim()}>
            add runner
          </button>
        </form>
      )}
      {error && <p className="key__err">{error}</p>}

      {tokens.length > 0 && (
        <ul className="tokens">
          {tokens.map((t) => (
            <li key={t.id}>
              <span>{t.name}</span>
              <span className="muted small">last seen {ago(t.lastSeen)}</span>
              <button className="ghost small" onClick={() => void revoke(t.id)} title="the runner using this token is disconnected immediately">
                revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
