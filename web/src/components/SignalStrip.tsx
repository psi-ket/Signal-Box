import { memo } from "react";
import type { DriftLevel, RoomState } from "../../../shared/protocol.ts";

const STALE_MS = 25_000;

const LEVEL_TEXT: Record<DriftLevel, string> = {
  clear: "Clear",
  overlap: "Shared file",
  conflict: "Merge conflict",
  unknown: "Scan failed",
};

/** The signal box: one lamp per session; overlaps and verified conflicts listed beside it. */
export const SignalStrip = memo(function SignalStrip({ state, now }: { state: RoomState; now: number }) {
  const drift = state.drift;
  const stale = !drift || now - drift.scannedAt > STALE_MS;
  const ids = state.sessionOrder.filter((id) => !["failed"].includes(state.sessions[id]!.status));
  const title = (id: string) => state.sessions[id]?.title ?? id;

  return (
    <section className="signal" aria-label="Drift between sessions">
      <div className="signal__lamps">
        {ids.length === 0 && <span className="signal__empty">Start a session to see its signal here.</span>}
        {ids.map((id) => {
          const entry = drift?.sessions[id];
          const files = entry?.files.filter((f) => !f.status.endsWith("-from")).length ?? 0;
          const cls = !entry ? "pending" : stale ? "stale" : entry.level;
          const label = !entry ? "Not scanned yet" : stale ? `Stale: ${LEVEL_TEXT[entry.level].toLowerCase()}` : LEVEL_TEXT[entry.level];
          return (
            <a key={id} href={`#pane-${id}`} className={`lamp lamp--${cls}`} title={entry?.error ?? label}>
              <span className="lamp__bulb" aria-hidden />
              <span className="lamp__name">{title(id)}</span>
              <span className="lamp__meta">
                {label}
                {entry && ` · ${files} file${files === 1 ? "" : "s"}`}
              </span>
            </a>
          );
        })}
      </div>

      <div className="signal__detail">
        {drift?.conflicts.map((c) => (
          <p key={c.sessionIds.join()} className="signal__row signal__row--conflict">
            <b>Conflict</b> {title(c.sessionIds[0])} ✕ {title(c.sessionIds[1])}: <code>{c.paths.join(", ")}</code>
          </p>
        ))}
        {drift?.overlaps
          .filter((o) => !drift.conflicts.some((c) => o.sessionIds.every((s) => c.sessionIds.includes(s)) && c.paths.includes(o.path)))
          .map((o) => (
            <p key={o.path} className="signal__row signal__row--overlap">
              <b>Shared file</b> <code>{o.path}</code> ({o.sessionIds.map(title).join(", ")}). Merges cleanly so far.
            </p>
          ))}
        <p className="signal__scan">
          {drift
            ? `${stale ? "Stale: last scan" : "Verified"} ${Math.max(0, Math.round((now - drift.scannedAt) / 1000))}s ago vs ${drift.baseRef}@${drift.baseSha.slice(0, 7)}${drift.conflictCheck === "disabled" ? " · conflict check off" : ""}`
            : "Waiting for the first scan"}
        </p>
      </div>
    </section>
  );
});
