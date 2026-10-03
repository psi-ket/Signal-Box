/**
 * The single authoritative state transition function. The server applies every
 * StateEvent with it before broadcasting; clients apply the same events to stay in sync.
 * Pure and immutable so React can rely on reference equality.
 */
import { MAX_CHAT_MESSAGES, type RoomState, type SessionView, type StateEvent, type TranscriptItem } from "./protocol.ts";

export const MAX_TRANSCRIPT_ITEMS = 400;
export const MAX_TEXT_ITEM_CHARS = 20_000;

export type RoomInit = Omit<RoomState, "seq" | "participants" | "sessions" | "sessionOrder" | "votes" | "chat" | "drift" | "recap" | "ended">;

export function emptyRoomState(init: RoomInit): RoomState {
  return { ...init, seq: 0, participants: {}, sessions: {}, sessionOrder: [], votes: {}, chat: [], drift: null, recap: null, ended: false };
}

function withSession(state: RoomState, sessionId: string, fn: (s: SessionView) => SessionView): RoomState {
  const s = state.sessions[sessionId];
  if (!s) return state;
  return { ...state, sessions: { ...state.sessions, [sessionId]: fn(s) } };
}

function capTranscript(items: TranscriptItem[]): TranscriptItem[] {
  return items.length > MAX_TRANSCRIPT_ITEMS ? items.slice(items.length - MAX_TRANSCRIPT_ITEMS) : items;
}

export function applyEvent(state: RoomState, ev: StateEvent): RoomState {
  // Events at or below the current seq were already applied (replay after reconnect).
  if (ev.seq <= state.seq) return state;
  const next = reduce(state, ev);
  return { ...next, seq: ev.seq };
}

function reduce(state: RoomState, ev: StateEvent): RoomState {
  switch (ev.type) {
    case "participant.upsert":
      return { ...state, participants: { ...state.participants, [ev.payload.id]: ev.payload } };

    case "participant.remove": {
      const { [ev.payload.participantId]: _gone, ...rest } = state.participants;
      return { ...state, participants: rest };
    }

    case "session.upsert": {
      const prev = state.sessions[ev.payload.id];
      const session: SessionView = { ...ev.payload, transcript: prev?.transcript ?? [] };
      const order = prev ? state.sessionOrder : [...state.sessionOrder, ev.payload.id];
      return { ...state, sessions: { ...state.sessions, [session.id]: session }, sessionOrder: order };
    }

    case "transcript.append":
      return withSession(state, ev.payload.sessionId, (s) => ({ ...s, transcript: capTranscript([...s.transcript, ev.payload.item]) }));

    case "transcript.delta":
      return withSession(state, ev.payload.sessionId, (s) => {
        const idx = s.transcript.findLastIndex((i) => i.id === ev.payload.itemId);
        const item = s.transcript[idx];
        if (!item || item.kind !== "text") return s;
        const text = (item.text + ev.payload.text).slice(-MAX_TEXT_ITEM_CHARS);
        const transcript = s.transcript.slice();
        transcript[idx] = { ...item, text };
        return { ...s, transcript };
      });

    case "transcript.update":
      return withSession(state, ev.payload.sessionId, (s) => {
        const idx = s.transcript.findLastIndex((i) => i.id === ev.payload.item.id);
        if (idx < 0) return s;
        const transcript = s.transcript.slice();
        transcript[idx] = ev.payload.item;
        return { ...s, transcript };
      });

    case "vote.upsert":
      return { ...state, votes: { ...state.votes, [ev.payload.id]: ev.payload } };

    case "chat.message": {
      const chat = [...state.chat, ev.payload];
      return { ...state, chat: chat.length > MAX_CHAT_MESSAGES ? chat.slice(chat.length - MAX_CHAT_MESSAGES) : chat };
    }

    case "runners.update":
      return { ...state, runners: ev.payload.runners };

    case "drift.report":
      return { ...state, drift: ev.payload };

    case "recap":
      return { ...state, recap: ev.payload };

    case "room.ended":
      return { ...state, ended: true };
  }
}
