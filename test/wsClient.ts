import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import {
  ServerMessage,
  WS_SUBPROTOCOL,
  isStateEvent,
  type ClientMessage,
  type ClientMessageType,
  type ClientPayload,
  type RoomState,
  type RoomSummary,
  type RunnerView,
  type ServerMessage as SM,
} from "../shared/protocol.ts";
import { applyEvent } from "../shared/reducer.ts";

type ErrorMsg = Extract<SM, { type: "error" }>;
type Welcome = Extract<SM, { type: "welcome" }>;

/** Minimal protocol client for integration tests; mirrors the browser client's behaviour. */
export class TestClient {
  ws!: WebSocket;
  messages: SM[] = [];
  state: RoomState | null = null;
  rooms: RoomSummary[] = [];
  runners: RunnerView[] = [];
  userId = "";
  username = "";
  private waiters: { pred: (m: SM) => boolean; resolve: (m: SM) => void }[] = [];

  get participantId() {
    return this.userId;
  }

  /** Connects with a session cookie; resolves after the lobby message. */
  static async connect(port: number, cookie: string | null, opts: { origin?: string } = {}): Promise<TestClient> {
    const c = new TestClient();
    c.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, [WS_SUBPROTOCOL], { origin: opts.origin ?? `http://127.0.0.1:${port}`, headers: cookie ? { cookie } : {} });
    c.ws.on("message", (d) => {
      const raw = JSON.parse(d.toString());
      const parsed = ServerMessage.safeParse(raw);
      if (!parsed.success) throw new Error("server sent invalid message: " + JSON.stringify(raw).slice(0, 300) + " " + parsed.error.issues[0]?.message);
      const m = raw as SM;
      c.messages.push(m);
      if (m.type === "welcome" || m.type === "snapshot") c.state = m.payload.state;
      else if (m.type === "room.left") c.state = null;
      else if (m.type === "lobby") {
        c.rooms = m.payload.rooms;
        c.runners = m.payload.runners;
        c.userId = m.payload.user.id;
        c.username = m.payload.user.username;
      } else if (m.type === "lobby.rooms") c.rooms = m.payload.rooms;
      else if (m.type === "runners") c.runners = m.payload.runners;
      else if (isStateEvent(m) && c.state) c.state = applyEvent(c.state, m);
      for (const w of c.waiters.slice()) if (w.pred(m)) (c.waiters.splice(c.waiters.indexOf(w), 1), w.resolve(m));
    });
    await new Promise<void>((res, rej) => {
      c.ws.once("open", () => res());
      c.ws.once("error", rej);
      c.ws.once("unexpected-response", (_req, r) => rej(new Error(`HTTP ${r.statusCode}`)));
    });
    await c.waitFor((m) => m.type === "lobby");
    return c;
  }

  send<T extends ClientMessageType>(type: T, payload: ClientPayload<T>): string {
    const eventId = randomUUID();
    this.ws.send(JSON.stringify({ type, eventId, timestamp: Date.now(), payload } as ClientMessage));
    return eventId;
  }

  waitFor<T extends SM>(pred: (m: SM) => m is T, timeoutMs?: number): Promise<T>;
  waitFor(pred: (m: SM) => boolean, timeoutMs?: number): Promise<SM>;
  waitFor(pred: (m: SM) => boolean, timeoutMs = 10_000): Promise<SM> {
    const hit = this.messages.find(pred);
    if (hit) return Promise.resolve(hit);
    return this.next(pred, timeoutMs);
  }

  /** Waits for the next matching message that arrives after this call. */
  next(pred: (m: SM) => boolean, timeoutMs = 10_000): Promise<SM> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timed out waiting for message")), timeoutMs);
      this.waiters.push({ pred, resolve: (m) => (clearTimeout(t), resolve(m)) });
    });
  }

  async until(pred: (s: RoomState) => boolean, timeoutMs = 10_000): Promise<RoomState> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (this.state && pred(this.state)) return this.state;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("timed out waiting for state");
  }

  errorFor(eventId: string): Promise<ErrorMsg> {
    return this.waitFor((m): m is ErrorMsg => m.type === "error" && m.payload.replyTo === eventId);
  }

  async createRoom(p: Partial<ClientPayload<"room.create">> & { gitUrl: string }): Promise<Welcome> {
    const w = this.next((m) => m.type === "welcome" || m.type === "error");
    this.send("room.create", { name: "test room", maxPeople: 10, defaultRole: "editor", ...p });
    const m = await w;
    if (m.type !== "welcome") throw new Error(`room.create failed: ${JSON.stringify(m.payload)}`);
    return m as Welcome;
  }

  async joinRoom(roomId: string, password?: string): Promise<Welcome | ErrorMsg> {
    const w = this.next((m) => m.type === "welcome" || m.type === "error");
    this.send("room.join", { roomId, ...(password !== undefined ? { password } : {}) });
    return (await w) as Welcome | ErrorMsg;
  }

  close() {
    this.ws.close();
  }
}
