import type { Recap as RecapT } from "../../../shared/protocol.ts";
import { formatDuration } from "./SessionPane.tsx";

const REASON: Record<string, string> = {
  majority: "majority",
  owner_tiebreak: "owner tiebreak",
  owner_no_votes: "owner (no votes)",
  fallback_owner_absent: "no decision, owner offline",
  fallback_owner_timeout: "no decision, owner timeout",
  session_cancelled: "cancelled",
};

export function Recap({ recap, onClose }: { recap: RecapT; onClose: () => void }) {
  return (
    <div className="recap" role="dialog" aria-modal="true" aria-label="Session recap">
      <div className="recap__sheet">
        <header className="recap__head">
          <h2 className="plate">recap</h2>
          <button className="ghost" onClick={onClose} autoFocus>
            Close
          </button>
        </header>

        <div className="recap__wrap">
        <table className="recap__table">
          <thead>
            <tr>
              <th>Session</th>
              <th>Status</th>
              <th>Time</th>
              <th>Files changed</th>
              <th>Commits</th>
              <th>Test runs</th>
              <th>Decisions</th>
            </tr>
          </thead>
          <tbody>
            {recap.sessions.map((s) => (
              <tr key={s.id}>
                <td>
                  <b>{s.title}</b>
                  <br />
                  <small>
                    {s.ownerName} · {s.provider}
                    {s.model ? `/${s.model}` : ""}
                  </small>
                  {s.errors.length > 0 && <small className="recap__err">{s.errors.at(-1)}</small>}
                </td>
                <td>{s.status}</td>
                <td>{formatDuration(s.durationMs)}</td>
                <td>
                  {s.filesChanged.length === 0 ? "none" : s.filesChanged.map((f) => <code key={f}>{f}</code>)}
                </td>
                <td>{s.commitsCreated}</td>
                <td>{s.testRuns.passed + s.testRuns.failed === 0 ? "none" : `${s.testRuns.passed} passed, ${s.testRuns.failed} failed`}</td>
                <td>{s.decisions}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>

        <div className="recap__cols">
          <section>
            <h3>Decisions</h3>
            <p>
              {recap.decisions.resolved} of {recap.decisions.raised} resolved
            </p>
            <ul>
              {Object.entries(recap.decisions.byReason).map(([k, n]) => (
                <li key={k}>
                  {REASON[k] ?? k}: {n}
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h3>Votes cast</h3>
            <ul>
              {recap.participation.map((p) => (
                <li key={p.name}>
                  {p.name}: {p.votesCast}
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h3>Merge conflicts</h3>
            {recap.unresolvedConflicts.length === 0 ? (
              <p>None detected{recap.driftVerifiedAt ? ` (verified ${new Date(recap.driftVerifiedAt).toLocaleTimeString()})` : ""}.</p>
            ) : (
              <ul>
                {recap.unresolvedConflicts.map((c) => (
                  <li key={c.sessionIds.join()}>
                    {recap.sessions.find((s) => s.id === c.sessionIds[0])?.title} ✕ {recap.sessions.find((s) => s.id === c.sessionIds[1])?.title}:{" "}
                    {c.paths.map((p) => <code key={p}>{p}</code>)}
                  </li>
                ))}
              </ul>
            )}
            <p className="hint">Branches are never merged automatically. Review each session branch before merging.</p>
          </section>
        </div>
      </div>
    </div>
  );
}
