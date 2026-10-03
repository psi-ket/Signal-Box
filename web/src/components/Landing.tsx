import { useEffect, useState } from "react";
import type { User } from "../api.ts";
import { linkProps } from "../router.ts";

/** One scripted beat of the hero replay. */
interface Beat {
  lines: [string[], string[], string[]];
  lamps: ["clear" | "overlap" | "conflict", "clear" | "overlap" | "conflict", "clear" | "overlap" | "conflict"];
  vote: null | { pg: number; sq: number; left: number; done?: boolean };
  signal: string;
}

const BEATS: Beat[] = [
  { lines: [["❯ ana: add persistence"], ["❯ bob: rename to TaskForge"], ["❯ cara: rename to TodoPro"]], lamps: ["clear", "clear", "clear"], vote: null, signal: "all clear" },
  { lines: [["❯ ana: add persistence", "reading src/store.js"], ["❯ bob: rename to TaskForge", "$ Edit README.md"], ["❯ cara: rename to TodoPro", "reading src/config.js"]], lamps: ["clear", "clear", "clear"], vote: null, signal: "all clear" },
  { lines: [["❯ ana: add persistence", "reading src/store.js", "? asking the team"], ["❯ bob: rename to TaskForge", "$ Edit README.md", "$ Edit src/config.js"], ["❯ cara: rename to TodoPro", "reading src/config.js"]], lamps: ["clear", "clear", "clear"], vote: { pg: 0, sq: 0, left: 30 }, signal: "all clear" },
  { lines: [["❯ ana: add persistence", "reading src/store.js", "? asking the team"], ["❯ bob: rename to TaskForge", "$ Edit README.md", "$ Edit src/config.js"], ["❯ cara: rename to TodoPro", "reading src/config.js", "$ Edit src/config.js"]], lamps: ["clear", "clear", "clear"], vote: { pg: 1, sq: 1, left: 21 }, signal: "all clear" },
  { lines: [["❯ ana: add persistence", "reading src/store.js", "? asking the team"], ["❯ bob: rename to TaskForge", "$ Edit README.md", "$ Edit src/config.js"], ["❯ cara: rename to TodoPro", "reading src/config.js", "$ Edit src/config.js"]], lamps: ["clear", "clear", "clear"], vote: { pg: 1, sq: 2, left: 14, done: true }, signal: "all clear" },
  { lines: [["❯ ana: add persistence", "team decision → SQLite", "$ Write src/db.js", "$ Edit README.md"], ["❯ bob: rename to TaskForge", "$ Edit README.md", "$ Edit src/config.js"], ["❯ cara: rename to TodoPro", "reading src/config.js", "$ Edit src/config.js"]], lamps: ["overlap", "overlap", "clear"], vote: null, signal: "shared file README.md · merges cleanly" },
  { lines: [["❯ ana: add persistence", "team decision → SQLite", "$ Write src/db.js", "$ Edit README.md"], ["❯ bob: rename to TaskForge", "$ Edit README.md", "$ Edit src/config.js", "$ git commit"], ["❯ cara: rename to TodoPro", "reading src/config.js", "$ Edit src/config.js", "$ git commit"]], lamps: ["overlap", "conflict", "conflict"], vote: null, signal: "conflict src/config.js · caught before merge" },
];

function Replay() {
  const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const [i, setI] = useState(reduced ? BEATS.length - 1 : 0);
  useEffect(() => {
    if (reduced) return;
    const t = setInterval(() => setI((x) => (x + 1) % (BEATS.length + 2)), 1500);
    return () => clearInterval(t);
  }, [reduced]);
  const b = BEATS[Math.min(i, BEATS.length - 1)]!;
  const names = ["storage", "rebrand-a", "rebrand-b"];
  const owners = ["ana · claude", "bob · codex", "cara · gemini"];
  return (
    <div className="replay" aria-label="Animated example: three agents, a team vote, and a merge conflict caught early" role="img">
      <div className="replay__bar">
        <span className="dots" aria-hidden>
          ● ● ●
        </span>
        <span className="muted">signalbox:~/todo-squad</span>
      </div>
      <div className="replay__lamps">
        {names.map((n, k) => (
          <span key={n} className={`mini-lamp mini-lamp--${b.lamps[k]}`}>
            <i aria-hidden />
            {n}
          </span>
        ))}
        <span className={`replay__signal${b.lamps.includes("conflict") ? " is-red" : b.lamps.includes("overlap") ? " is-amber" : ""}`}>{b.signal}</span>
      </div>
      <div className="replay__panes">
        {names.map((n, k) => (
          <div key={n} className="mini-pane">
            <p className="mini-pane__head">
              ▸ {n} <span className="muted">{owners[k]}</span>
            </p>
            {b.lines[k]!.map((l, j) => (
              <p key={j} className={l.startsWith("❯") ? "l-prompt" : l.startsWith("?") ? "l-ask" : l.startsWith("team") ? "l-decision" : l.startsWith("$") ? "l-tool" : "l-text"}>
                {l}
              </p>
            ))}
            <p className="l-cursor" aria-hidden>
              ▌
            </p>
          </div>
        ))}
      </div>
      {b.vote && (
        <div className={`mini-vote${b.vote.done ? " is-done" : ""}`}>
          <p className="mini-vote__head">
            <b>? database</b> <span className="muted">storage · ana</span> <span className="mini-vote__clock">{b.vote.done ? "✓" : `${b.vote.left}s`}</span>
          </p>
          <p className="mini-vote__q">Which database should the todo app use?</p>
          {(
            [
              ["PostgreSQL", b.vote.pg],
              ["SQLite", b.vote.sq],
            ] as const
          ).map(([label, n]) => (
            <p key={label} className={`mini-opt${b.vote!.done && label === "SQLite" ? " is-won" : ""}`}>
              <span className="mini-opt__bar" style={{ width: `${(n / 3) * 100}%` }} />
              <span>{label}</span>
              <b>{n}</b>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

export function Landing({ user }: { user: User | null }) {
  return (
    <div className="landing">
      <nav className="lnav">
        <a {...linkProps("/")} className="brand">
          <span className="brand__lamp" aria-hidden />
          signal box
        </a>
        <span className="lnav__links">
          <a href="#how">how it works</a>
          <a href="#trust">security</a>
          {user ? (
            <a {...linkProps("/rooms")} className="btn">
              open rooms
            </a>
          ) : (
            <>
              <a {...linkProps("/login")}>sign in</a>
              <a {...linkProps("/register")} className="btn">
                create account
              </a>
            </>
          )}
        </span>
      </nav>

      <header className="hero">
        <div className="hero__copy">
          <p className="eyebrow">for teams running coding agents in parallel</p>
          <h1>
            Run a team of coding agents.
            <br />
            <span className="hl">Decide together.</span>
          </h1>
          <p className="lede">
            Signal Box puts every agent your team runs on one live screen. When an agent hits a real design decision, everyone votes. When two agents are about to collide, the signal turns red before anyone merges.
          </p>
          <p className="hero__cta">
            <a {...linkProps(user ? "/rooms" : "/register")} className="btn btn--big">
              {user ? "open your rooms" : "create a free account"}
            </a>
            {!user && (
              <a {...linkProps("/login")} className="btn btn--ghost">
                sign in
              </a>
            )}
          </p>
          <p className="works">works with Claude Code · Codex CLI · Gemini CLI · OpenAI and Gemini APIs</p>
        </div>
        <Replay />
      </header>

      <section id="how" className="lsection">
        <h2>
          <span className="muted">$</span> how it works
        </h2>
        <ol className="steps">
          <li>
            <b>Create a room from a Git URL.</b>
            <span>Name it, set a password and how many people can join, and choose what newcomers may do.</span>
          </li>
          <li>
            <b>Each teammate connects a runner.</b>
            <span>One command on your own machine. Agents run there, in their own branch, with your Claude, Codex or Gemini login or your own API key.</span>
          </li>
          <li>
            <b>Spawn agents. Vote. Watch the signals.</b>
            <span>Design questions become team votes, risky commands go to the agent's owner, and the signal strip shows overlaps and real merge conflicts as they happen.</span>
          </li>
        </ol>
      </section>

      <section className="lsection">
        <h2>
          <span className="muted">$</span> what the room gives you
        </h2>
        <div className="features">
          {[
            ["team votes", "An agent's genuine decision (which database, which library) pops up on every screen with a 30-second fuse. Majority wins; ties go to the agent's owner."],
            ["owner approvals", "A command outside the safe list goes only to the person who started that agent. No answer means no."],
            ["drift signals", "Amber when agents touch the same file, red only when Git confirms their changes won't merge."],
            ["your keys, your machine", "Agents run on your runner with your logins or API keys. Keys are checked by listing models and never leave your machine."],
            ["roles and chat", "Admins, editors, voters and viewers. Every room has its own chat, and votes and joins are logged there too."],
            ["everything live", "Streaming output rendered as Markdown, tool calls and results, file changes, and a recap of what each agent actually did."],
          ].map(([t, d]) => (
            <article key={t} className="box feature">
              <h3 className="box__title">{t}</h3>
              <p>{d}</p>
            </article>
          ))}
        </div>
      </section>

      <section id="trust" className="lsection trust">
        <h2>
          <span className="muted">$</span> the hub never runs your code
        </h2>
        <pre className="diagram" aria-label="Browsers talk to the hub; runners on each teammate's machine run agents and talk to the hub">{`  browser ──┐                          ┌── runner (ana's laptop)  → claude
  browser ──┼──▶  hub: rooms · votes ◀─┼── runner (bob's laptop)  → codex
  browser ──┘     chat · drift checks  └── runner (cara's desktop) → gemini`}</pre>
        <ul className="trust__list">
          <li>The hub stores accounts, rooms and chat. It relays tasks, collects votes and checks patches for conflicts.</li>
          <li>Runners clone with your own Git access and keep your API keys in memory on your machine.</li>
          <li>Every tool call passes a deny-by-default policy on the runner. Dangerous commands are blocked outright.</li>
        </ul>
      </section>

      <section className="lsection final">
        <h2>Start a room in a minute.</h2>
        <a {...linkProps(user ? "/rooms" : "/register")} className="btn btn--big">
          {user ? "open your rooms" : "create a free account"}
        </a>
      </section>

      <footer className="lfoot">
        <span>signal box</span>
        <span className="muted">agents work in parallel; people stay in charge.</span>
      </footer>
    </div>
  );
}
