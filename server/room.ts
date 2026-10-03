/**
 * Authoritative room state. All shared state changes go through dispatch(), which
 * stamps an envelope + sequence number, applies the shared reducer, and notifies
 * the transport. Nothing else holds copies of session or vote state.
 */
import { randomUUID } from "node:crypto";
import type { RoomState, StateEvent } from "../shared/protocol.ts";
import { applyEvent, emptyRoomState } from "../shared/reducer.ts";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type StateEventInput = DistributiveOmit<StateEvent, "seq" | "eventId" | "timestamp" | "roomId">;

export class Room {
  state: RoomState;
  private subs = new Set<(ev: StateEvent) => void>();

  constructor(init: Parameters<typeof emptyRoomState>[0]) {
    this.state = emptyRoomState(init);
  }

  dispatch(input: StateEventInput): StateEvent {
    const ev = {
      ...input,
      eventId: randomUUID(),
      timestamp: Date.now(),
      roomId: this.state.roomId,
      seq: this.state.seq + 1,
    } as StateEvent;
    this.state = applyEvent(this.state, ev);
    for (const fn of this.subs) fn(ev);
    return ev;
  }

  subscribe(fn: (ev: StateEvent) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
}
