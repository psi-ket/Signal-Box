import type { Role, RoomState } from "../../../shared/protocol.ts";

const ROLE_HELP: Record<Role, string> = {
  admin: "manage room and people",
  editor: "run agents, vote, chat",
  voter: "vote and chat",
  viewer: "watch and chat",
};

export function People({ state, meId, myRole, onRole, onKick }: { state: RoomState; meId: string; myRole: Role; onRole: (id: string, r: Role) => void; onKick: (id: string) => void }) {
  const people = Object.values(state.participants).sort((a, b) => Number(b.online) - Number(a.online) || a.joinedAt - b.joinedAt);
  const isAdmin = myRole === "admin";
  return (
    <section className="box people">
      <h2 className="box__title">
        people {people.filter((p) => p.online).length}/{state.settings.maxPeople}
      </h2>
      <ul>
        {people.map((p) => (
          <li key={p.id} className={p.online ? "" : "dim"}>
            <span className={p.online ? "ok" : "off"} aria-label={p.online ? "online" : "offline"}>
              {p.online ? "●" : "○"}
            </span>
            <span className="people__name">
              {p.name}
              {p.id === meId && <span className="muted"> (you)</span>}
              {p.isHost && <span className="tag tag--host">host</span>}
            </span>
            {isAdmin && !p.isHost && p.id !== meId ? (
              <span className="people__ctl">
                <select value={p.role} onChange={(e) => onRole(p.id, e.target.value as Role)} aria-label={`role for ${p.name}`} title={ROLE_HELP[p.role]}>
                  {(["admin", "editor", "voter", "viewer"] as Role[]).map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
                <button className="ghost small" onClick={() => onKick(p.id)} title={`remove ${p.name} from the room`}>
                  kick
                </button>
              </span>
            ) : (
              <span className={`tag tag--${p.role}`} title={ROLE_HELP[p.role]}>
                {p.role}
              </span>
            )}
            <small className="people__where">
              {p.online ? (p.viewingSessionId ? `watching ${state.sessions[p.viewingSessionId]?.title ?? "a session"}` : "idle") : "offline"}
            </small>
          </li>
        ))}
      </ul>
    </section>
  );
}
