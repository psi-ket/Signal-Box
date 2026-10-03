/**
 * Session recap from objective indicators only: files changed (drift snapshot vs base),
 * commits on the session branch, test command outcomes, decisions, errors.
 */
import type { Recap, RoomState } from "../shared/protocol.ts";
import type { SessionManager } from "./sessions.ts";

export async function buildRecap(state: RoomState, sessions: SessionManager, commitsFor: (sessionId: string) => number, ballots: Map<string, number>): Promise<Recap> {
  const now = Date.now();
  const drift = state.drift;
  const out: Recap["sessions"] = [];
  for (const id of state.sessionOrder) {
    const s = state.sessions[id]!;
    const stats = sessions.stats(id);
    const commits = commitsFor(id); // as reported by the runner's last drift snapshot
    out.push({
      id,
      title: s.title,
      ownerName: s.ownerName,
      provider: s.provider,
      model: s.model,
      status: s.status,
      durationMs: s.startedAt ? (s.endedAt ?? now) - s.startedAt : 0,
      filesChanged: drift?.sessions[id]?.files.filter((f) => !f.status.endsWith("-from")).map((f) => `${f.status} ${f.path}`) ?? s.filesTouched,
      commitsCreated: commits,
      testRuns: stats?.testRuns ?? { passed: 0, failed: 0 },
      decisions: stats?.decisions ?? 0,
      errors: stats?.errors.slice(-5) ?? (s.error ? [s.error] : []),
    });
  }
  const votes = Object.values(state.votes);
  const byReason: Record<string, number> = {};
  for (const v of votes) if (v.resolution) byReason[v.resolution] = (byReason[v.resolution] ?? 0) + 1;
  return {
    generatedAt: now,
    sessions: out,
    decisions: { raised: votes.length, resolved: votes.filter((v) => v.phase === "resolved").length, byReason },
    participation: Object.values(state.participants)
      .map((p) => ({ name: p.name, votesCast: ballots.get(p.id) ?? 0 }))
      .sort((a, b) => b.votesCast - a.votesCast),
    unresolvedConflicts: drift?.conflicts ?? [],
    driftVerifiedAt: drift?.scannedAt ?? null,
  };
}
