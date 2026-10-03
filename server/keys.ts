/**
 * Bring-your-own API keys: verification by listing a vendor's models ("ping"). Keys are
 * checked and held by the participant's runner (runner/core.ts), never by the hub.
 */
import type { KeyVendor, ProviderId } from "../shared/protocol.ts";
import { listGeminiModels } from "./agents/gemini.ts";

export const VENDOR_FOR_PROVIDER: Partial<Record<ProviderId, KeyVendor>> = {
  claude: "anthropic",
  "openai-api": "openai",
  "gemini-cli": "gemini",
  "gemini-api": "gemini",
};

type Model = { id: string; label: string };

const KEY_SHAPE: Record<KeyVendor, RegExp> = {
  anthropic: /^[\w-]{20,300}$/,
  openai: /^[\w-]{20,300}$/,
  gemini: /^[\w.-]{20,300}$/,
};

export function maskKey(key: string): string {
  return key.length <= 10 ? "****" : `${key.slice(0, 4)}…${key.slice(-4)}`;
}

async function getJson(url: string, headers: Record<string, string>, key: string): Promise<any> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (body as { error?: { message?: string } | string }).error;
    const text = typeof msg === "string" ? msg : (msg?.message ?? res.statusText);
    throw new Error(`HTTP ${res.status}: ${String(text).replaceAll(key, "***").slice(0, 200)}`);
  }
  return body;
}

/** Verifies a key by listing models. Throws with a readable message if the key is rejected. */
export async function checkKey(vendor: KeyVendor, key: string): Promise<Model[]> {
  if (!KEY_SHAPE[vendor].test(key)) throw new Error("that doesn't look like an API key");
  switch (vendor) {
    case "anthropic": {
      const b = await getJson("https://api.anthropic.com/v1/models?limit=100", { "x-api-key": key, "anthropic-version": "2023-06-01" }, key);
      return ((b.data ?? []) as { id: string; display_name?: string }[]).map((m) => ({ id: m.id, label: m.display_name ?? m.id }));
    }
    case "openai": {
      const b = await getJson("https://api.openai.com/v1/models", { authorization: `Bearer ${key}` }, key);
      return ((b.data ?? []) as { id: string }[])
        .map((m) => m.id)
        .filter((id) => /^(gpt-|o\d|chatgpt-)/.test(id) && !/(audio|realtime|tts|transcribe|image|embedding|search|moderation|instruct)/.test(id))
        .sort()
        .reverse()
        .map((id) => ({ id, label: id }));
    }
    case "gemini":
      return listGeminiModels(key);
  }
}
