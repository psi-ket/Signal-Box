/**
 * Live connection for a logged-in user: one WebSocket (authenticated by the session
 * cookie, automatic reconnection) carries the lobby, the user's runners and keys, and the
 * current room. On reconnect it rejoins the room it was in and gets a full snapshot.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ServerMessage,
  WS_SUBPROTOCOL,
  isStateEvent,
  type ClientMessageType,
  type ClientPayload,
  type KeyVendor,
  type RoomState,
  type RoomSummary,
  type RunnerView,
  type ServerMessage as SM,
} from "../../shared/protocol.ts";
import { applyEvent } from "../../shared/reducer.ts";

export type ConnStatus = "connecting" | "open" | "reconnecting" | "signed_out";

export interface Toast {
  id: string;
  text: string;
  tone: "error" | "info";
}

export interface MyKey {
  vendor: KeyVendor;
  masked: string;
  models: { id: string; label: string }[];
  checkedAt: number;
}

export interface Me {
  id: string;
  username: string;
  isAdmin: boolean;
}

export function useSite(enabled: boolean) {
  const [status, setStatus] = useState<ConnStatus>("connecting");
  const [me, setMe] = useState<Me | null>(null);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [runners, setRunners] = useState<RunnerView[]>([]);
  const [allowLocalRepos, setAllowLocalRepos] = useState(false);
  const [room, setRoom] = useState<RoomState | null>(null);
  const [myVotes, setMyVotes] = useState<Record<string, string>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [clockOffset, setClockOffset] = useState(0);
  const [myKeys, setMyKeys] = useState<MyKey[]>([]);
  const [keyResult, setKeyResult] = useState<{ vendor: KeyVendor; ok: boolean; error: string | null; at: number } | null>(null);
  const [lastError, setLastError] = useState<{ code: string; message: string; at: number } | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const roomRef = useRef<RoomState | null>(null);
  /** Room to (re)join after connecting, with the password that worked. */
  const wantRoom = useRef<{ id: string; password?: string } | null>(null);

  const toast = useCallback((text: string, tone: Toast["tone"] = "error") => {
    const id = crypto.randomUUID();
    setToasts((t) => [...t.slice(-3), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: SM[] = [];
    let raf = 0;

    const flush = () => {
      raf = 0;
      let s = roomRef.current;
      if (!s) return void (pending = []);
      for (const m of pending) if (isStateEvent(m)) s = applyEvent(s, m);
      pending = [];
      roomRef.current = s;
      setRoom(s);
    };

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${location.host}/ws`, [WS_SUBPROTOCOL]);
      wsRef.current = ws;
      let opened = false;
      ws.onopen = () => {
        opened = true;
        attempt = 0;
      };

      ws.onmessage = (e) => {
        let data: unknown;
        try {
          data = JSON.parse(e.data as string);
        } catch {
          return;
        }
        const parsed = ServerMessage.safeParse(data);
        if (!parsed.success) {
          console.warn("[signalbox] dropped invalid server message", parsed.error.issues[0]);
          return;
        }
        const m = data as SM;
        switch (m.type) {
          case "lobby":
            setMe(m.payload.user);
            setRooms(m.payload.rooms);
            setRunners(m.payload.runners);
            setAllowLocalRepos(m.payload.allowLocalRepos);
            setClockOffset(m.timestamp - Date.now());
            setStatus("open");
            if (wantRoom.current)
              ws.send(JSON.stringify({ type: "room.join", eventId: crypto.randomUUID(), timestamp: Date.now(), payload: { roomId: wantRoom.current.id, ...(wantRoom.current.password ? { password: wantRoom.current.password } : {}) } }));
            return;
          case "lobby.rooms":
            setRooms(m.payload.rooms);
            return;
          case "runners":
            setRunners(m.payload.runners);
            return;
          case "keys":
            setMyKeys(m.payload.keys);
            if (m.payload.last) setKeyResult({ ...m.payload.last, at: Date.now() });
            return;
          case "welcome":
          case "snapshot":
            pending = [];
            roomRef.current = m.payload.state;
            setRoom(m.payload.state);
            setMyVotes(m.payload.myVotes);
            if (m.type === "welcome") wantRoom.current = { id: m.payload.roomId, password: wantRoom.current?.id === m.payload.roomId ? wantRoom.current.password : undefined };
            return;
          case "room.left":
            wantRoom.current = null;
            roomRef.current = null;
            setRoom(null);
            if (m.payload.reason !== "left") toast(m.payload.reason === "kicked" ? "You were removed from the room." : "The room was closed.", "info");
            return;
          case "vote.ack":
            setMyVotes((v) => ({ ...v, [m.payload.voteId]: m.payload.optionId }));
            return;
          case "error":
            setLastError({ code: m.payload.code, message: m.payload.message, at: Date.now() });
            if (["bad_password", "room_full", "not_found", "forbidden"].includes(m.payload.code) && !roomRef.current) wantRoom.current = null;
            toast(m.payload.message);
            return;
          default:
            // Batch room events per animation frame so streaming text stays smooth.
            pending.push(m);
            if (!raf) raf = requestAnimationFrame(flush);
        }
      };

      ws.onclose = () => {
        if (stopped) return;
        if (!opened && attempt >= 1) {
          // The upgrade was refused; most likely the login session expired.
          fetch("/api/me", { credentials: "same-origin" })
            .then((r) => {
              if (r.status === 401) {
                stopped = true;
                setStatus("signed_out");
              }
            })
            .catch(() => {});
        }
        setStatus((s) => (s === "signed_out" ? s : "reconnecting"));
        const delay = Math.min(10_000, 500 * 2 ** attempt) * (0.75 + Math.random() * 0.5);
        attempt++;
        timer = setTimeout(() => !stopped && connect(), delay);
      };
    };

    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      if (raf) cancelAnimationFrame(raf);
      wsRef.current?.close(1000, "unmount");
    };
  }, [enabled, toast]);

  const send = useCallback(
    <T extends ClientMessageType>(type: T, payload: ClientPayload<T>) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return void toast("Not connected. Your action was not sent.");
      ws.send(JSON.stringify({ type, eventId: crypto.randomUUID(), timestamp: Date.now(), payload }));
    },
    [toast],
  );

  const joinRoom = useCallback(
    (id: string, password?: string) => {
      wantRoom.current = { id, password };
      send("room.join", { roomId: id, ...(password ? { password } : {}) });
    },
    [send],
  );

  const leaveRoom = useCallback(() => {
    wantRoom.current = null;
    roomRef.current = null;
    setRoom(null);
    send("room.leave", {});
  }, [send]);

  const createRoom = useCallback(
    (p: ClientPayload<"room.create">) => {
      wantRoom.current = null;
      send("room.create", p);
    },
    [send],
  );

  return { status, me, rooms, runners, allowLocalRepos, room, myVotes, toasts, clockOffset, lastError, myKeys, keyResult, send, joinRoom, leaveRoom, createRoom, toast };
}

export type Site = ReturnType<typeof useSite>;
