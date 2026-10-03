/** Account API client (JSON over HTTP, session cookie). */
export interface User {
  id: string;
  username: string;
  isAdmin: boolean;
}

export interface RunnerToken {
  id: string;
  name: string;
  createdAt: number;
  lastSeen: number | null;
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: body !== undefined || method !== "GET" ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : method !== "GET" ? "{}" : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw Object.assign(new Error(data.error ?? `request failed (${res.status})`), { status: res.status, data });
  return data;
}

export const api = {
  me: () => call<{ user: User; registration: string }>("GET", "/api/me"),
  login: (username: string, password: string) => call<{ user: User }>("POST", "/api/login", { username, password }),
  register: (username: string, password: string) => call<{ user: User }>("POST", "/api/register", { username, password }),
  logout: () => call<{ ok: true }>("POST", "/api/logout"),
  runners: () => call<{ runners: RunnerToken[] }>("GET", "/api/runners"),
  createRunner: (name: string) => call<{ id: string; name: string; token: string }>("POST", "/api/runners", { name }),
  revokeRunner: (id: string) => call<{ ok: true }>("DELETE", `/api/runners/${encodeURIComponent(id)}`),
};
