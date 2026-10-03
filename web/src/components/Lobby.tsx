import { useState, type FormEvent } from "react";
import type { ClientPayload, Role, RoomSummary } from "../../../shared/protocol.ts";
import { linkProps } from "../router.ts";
import type { Site } from "../useSite.ts";
import { Keys } from "./Keys.tsx";
import { Runners } from "./Runners.tsx";

const ago = (t: number, now: number) => {
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
};

function CreateRoom({ onCreate, allowLocal }: { onCreate: (p: ClientPayload<"room.create">) => void; allowLocal: boolean }) {
  const [name, setName] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [baseRef, setBaseRef] = useState("");
  const [password, setPassword] = useState("");
  const [maxPeople, setMaxPeople] = useState(8);
  const [defaultRole, setDefaultRole] = useState<Role>("editor");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !gitUrl.trim()) return;
    onCreate({ name: name.trim(), gitUrl: gitUrl.trim(), ...(baseRef.trim() ? { baseRef: baseRef.trim() } : {}), ...(password ? { password } : {}), maxPeople, defaultRole });
  };

  return (
    <form className="box create" onSubmit={submit}>
      <h2 className="box__title">new room</h2>
      <label>
        <span>name</span>
        <input value={name} maxLength={48} onChange={(e) => setName(e.target.value)} placeholder="hackathon-backend" required />
      </label>
      <label>
        <span>git url</span>
        <input value={gitUrl} maxLength={400} onChange={(e) => setGitUrl(e.target.value)} placeholder={allowLocal ? "https://github.com/you/repo.git or C:\\code\\repo" : "https://github.com/you/repo.git"} required spellCheck={false} />
      </label>
      <div className="row2">
        <label>
          <span>base branch</span>
          <input value={baseRef} maxLength={100} onChange={(e) => setBaseRef(e.target.value)} placeholder="main" spellCheck={false} />
        </label>
        <label>
          <span>room password</span>
          <input type="password" value={password} maxLength={128} onChange={(e) => setPassword(e.target.value)} placeholder="optional" autoComplete="new-password" />
        </label>
      </div>
      <div className="row2">
        <label>
          <span>max people</span>
          <input type="number" min={1} max={64} value={maxPeople} onChange={(e) => setMaxPeople(Math.max(1, Math.min(64, Number(e.target.value) || 1)))} />
        </label>
        <label>
          <span>new members join as</span>
          <select value={defaultRole} onChange={(e) => setDefaultRole(e.target.value as Role)}>
            <option value="editor">editor: run agents, vote, chat</option>
            <option value="voter">voter: vote and chat</option>
            <option value="viewer">viewer: watch and chat</option>
          </select>
        </label>
      </div>
      <p className="muted small">Each teammate's runner clones this URL with their own Git access. Private repos work as long as each person can clone them.</p>
      <button type="submit" disabled={!name.trim() || !gitUrl.trim()}>
        create room
      </button>
    </form>
  );
}

export function Lobby({ site, now, onLogout }: { site: Site; now: number; onLogout: () => void }) {
  const me = site.me!;
  const { rooms } = site;
  const hasRunner = site.runners.some((r) => r.ownerId === me.id || r.shared);

  return (
    <main className="lobby">
      <div className="lobby__top">
        <p className="prompt-line">
          <span className="ps1">{me.username}@signalbox</span>:<span className="cwd">~/rooms</span>$ ls -l
          {me.isAdmin && <span className="tag tag--host">site admin</span>}
        </p>
        <span>
          <a {...linkProps("/")} className="ghost-link">
            home
          </a>{" "}
          <button className="ghost small" onClick={onLogout}>
            sign out
          </button>
        </span>
      </div>

      <section className="box">
        <h2 className="box__title">rooms ({rooms.length})</h2>
        {rooms.length === 0 ? (
          <p className="muted">No rooms yet. Create one below; your teammates will see it here after they sign in.</p>
        ) : (
          <div className="table-wrap">
            <table className="ls">
              <thead>
                <tr>
                  <th>room</th>
                  <th>repo</th>
                  <th>people</th>
                  <th>agents</th>
                  <th>votes</th>
                  <th>owner</th>
                  <th>age</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rooms.map((r: RoomSummary) => (
                  <tr key={r.id} className={r.ended ? "dim" : ""}>
                    <td>
                      {r.hasPassword && <span className="lock" title="password protected">[pw] </span>}
                      <b>{r.name}</b>
                      {r.ended && <span className="muted"> (ended)</span>}
                    </td>
                    <td className="muted">{r.repoName}</td>
                    <td>
                      {r.online}/{r.maxPeople}
                    </td>
                    <td>{r.activeSessions}</td>
                    <td className={r.openVotes ? "hot" : ""}>{r.openVotes}</td>
                    <td className="muted">{r.createdBy}</td>
                    <td className="muted">{ago(r.createdAt, now)}</td>
                    <td>
                      <a {...linkProps(`/rooms/${r.id}`)} className="ghost-link">
                        join
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="lobby__cols">
        <CreateRoom onCreate={(p) => site.createRoom(p)} allowLocal={site.allowLocalRepos} />
        <div className="stack">
          <Runners online={site.runners} meId={me.id} />
          <Keys myKeys={site.myKeys} keyResult={site.keyResult} send={site.send} disabled={!hasRunner} />
        </div>
      </div>
    </main>
  );
}
