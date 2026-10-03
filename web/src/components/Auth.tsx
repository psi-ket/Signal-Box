import { useState, type FormEvent } from "react";
import { api, type User } from "../api.ts";
import { linkProps, navigate } from "../router.ts";

export function Auth({ mode, onAuthed }: { mode: "login" | "register"; onAuthed: (u: User) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const register = mode === "register";
  const next = new URLSearchParams(location.search).get("next");
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/rooms";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (register && password !== confirm) return setError("the passwords don't match");
    setBusy(true);
    try {
      const r = register ? await api.register(username.trim(), password) : await api.login(username.trim(), password);
      onAuthed(r.user);
      navigate(safeNext, { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="gate">
      <form className="box gate__card auth" onSubmit={submit} noValidate>
        <h1 className="box__title">{register ? "create account" : "sign in"}</h1>
        <a {...linkProps("/")} className="brand brand--small">
          <span className="brand__lamp" aria-hidden />
          signal box
        </a>
        <label>
          <span>username</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus spellCheck={false} maxLength={24} required />
        </label>
        <label>
          <span>password</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={register ? "new-password" : "current-password"} minLength={register ? 10 : undefined} required />
        </label>
        {register && (
          <label>
            <span>password again</span>
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
          </label>
        )}
        {register && <p className="muted small">3-24 letters, digits, _ or -. Password at least 10 characters.</p>}
        {error && (
          <p className="auth__err" role="alert">
            error: {error}
          </p>
        )}
        <button type="submit" disabled={busy || !username.trim() || !password}>
          {busy ? "…" : register ? "create account" : "sign in"}
        </button>
        <p className="muted small">
          {register ? (
            <>
              Already have an account? <a {...linkProps(`/login${next ? `?next=${encodeURIComponent(next)}` : ""}`)}>Sign in</a>
            </>
          ) : (
            <>
              New here? <a {...linkProps(`/register${next ? `?next=${encodeURIComponent(next)}` : ""}`)}>Create an account</a>
            </>
          )}
        </p>
      </form>
    </main>
  );
}
