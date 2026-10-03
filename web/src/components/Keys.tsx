import { useEffect, useState, type FormEvent } from "react";
import type { ClientPayload, KeyVendor } from "../../../shared/protocol.ts";
import type { MyKey } from "../useSite.ts";

const VENDORS: { id: KeyVendor; label: string; runs: string; placeholder: string }[] = [
  { id: "anthropic", label: "Anthropic", runs: "Claude agents", placeholder: "sk-ant-…" },
  { id: "openai", label: "OpenAI", runs: "OpenAI API agents", placeholder: "sk-…" },
  { id: "gemini", label: "Google Gemini", runs: "Gemini CLI and Gemini API agents", placeholder: "AIza… or AQ.…" },
];

const ago = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
};

function KeyRow({ v, have, result, send }: { v: (typeof VENDORS)[number]; have?: MyKey; result: { ok: boolean; error: string | null; at: number } | null; send: <T extends "key.set" | "key.clear">(t: T, p: ClientPayload<T>) => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!result) return;
    setBusy(false);
    if (result.ok) setValue("");
  }, [result]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value.trim().length < 10) return;
    setBusy(true);
    send("key.set", { vendor: v.id, apiKey: value.trim() });
  };

  return (
    <li className="key">
      <p className="key__head">
        <b>{v.label}</b> <span className="muted">→ {v.runs}</span>
      </p>
      {have ? (
        <p className="key__ok">
          <span className="ok">[ok]</span> {have.masked} · {have.models.length} model{have.models.length === 1 ? "" : "s"} · checked {ago(have.checkedAt)}{" "}
          <button className="ghost small" onClick={() => send("key.clear", { vendor: v.id })}>
            remove
          </button>
        </p>
      ) : (
        <form className="key__form" onSubmit={submit}>
          <label className="sr-only" htmlFor={`key-${v.id}`}>
            {v.label} API key
          </label>
          <input id={`key-${v.id}`} type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder={v.placeholder} autoComplete="off" spellCheck={false} />
          <button type="submit" disabled={busy || value.trim().length < 10}>
            {busy ? "checking…" : "check"}
          </button>
        </form>
      )}
      {result && !result.ok && !have && <p className="key__err">{result.error}</p>}
    </li>
  );
}

export function Keys({ myKeys, keyResult, send, disabled }: { disabled?: boolean; myKeys: MyKey[]; keyResult: { vendor: KeyVendor; ok: boolean; error: string | null; at: number } | null; send: <T extends "key.set" | "key.clear">(t: T, p: ClientPayload<T>) => void }) {
  return (
    <section className="box keys">
      <h2 className="box__title">your api keys</h2>
      <p className="muted small">
        Optional. Agents you start can bill your own Anthropic, OpenAI or Gemini key instead of your runner's logins. The key passes through the hub to <b>your runner</b>, which checks it by listing models and keeps it in memory on your machine. Others never see it.
      </p>
      {disabled ? (
        <p className="off">Connect a runner first; keys are stored on your runner.</p>
      ) : (
      <ul>
        {VENDORS.map((v) => (
          <KeyRow key={v.id} v={v} have={myKeys.find((k) => k.vendor === v.id)} result={keyResult?.vendor === v.id ? keyResult : null} send={send} />
        ))}
      </ul>
      )}
    </section>
  );
}
