/**
 * Git URL handling shared by the hub (bare mirror for drift) and runners (working clones).
 * A room's Git URL is user input that reaches `git clone`, so it is validated strictly:
 * only https/ssh/git transports (local paths only when explicitly allowed), no embedded
 * credentials, and git's command-executing transports (ext::, fd::) are blocked via
 * GIT_ALLOW_PROTOCOL on every clone and fetch.
 */
import path from "node:path";

export class GitUrlError extends Error {}

const SCP_LIKE = /^[\w.-]+@[\w.-]+:[\w./~-]+$/; // git@github.com:owner/repo.git

export function validateGitUrl(raw: string, opts: { allowLocal: boolean }): string {
  const url = raw.trim();
  if (!url || url.length > 400) throw new GitUrlError("enter a Git URL");
  if (url.startsWith("-") || /\s/.test(url) || /^(ext|fd)::/i.test(url) || url.includes("::")) throw new GitUrlError("that Git URL is not allowed");
  if (SCP_LIKE.test(url)) return url;
  let u: URL | null = null;
  try {
    u = new URL(url);
  } catch {
    u = null;
  }
  if (u && /^[a-z]{2,}:$/i.test(u.protocol)) {
    if (["https:", "ssh:", "git:"].includes(u.protocol)) {
      if (u.password || (u.username && u.protocol === "https:")) throw new GitUrlError("don't put credentials in the URL; each person's own Git login is used");
      if (!u.hostname) throw new GitUrlError("the Git URL has no host");
      return url;
    }
    if (u.protocol === "file:" && opts.allowLocal) return url;
    if (u.protocol === "http:") throw new GitUrlError("use https:// (plain http is not allowed)");
    throw new GitUrlError(`${u.protocol}// URLs are not allowed`);
  }
  // Local path (including Windows drive paths, which URL() parses as a protocol "c:")
  if (opts.allowLocal && (path.isAbsolute(url) || /^[a-zA-Z]:[\\/]/.test(url))) return path.resolve(url);
  throw new GitUrlError(opts.allowLocal ? "use an https://, ssh or git@ URL, or an absolute local path" : "use an https://, ssh:// or git@host:owner/repo URL");
}

/** Human-friendly repo name: last path segment without .git. */
export function repoNameFromUrl(url: string): string {
  const last = url.replace(/[\\/]+$/, "").split(/[\\/:]/).pop() ?? "repo";
  return last.replace(/\.git$/, "") || "repo";
}

/** Environment for git network operations: no prompts, safe transports only. */
export function gitNetEnv(allowLocal: boolean): Record<string, string> {
  return { GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: allowLocal ? "https:ssh:git:file" : "https:ssh:git", GCM_INTERACTIVE: "never" };
}
