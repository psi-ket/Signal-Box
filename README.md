# Signal Box: collaborative agent supervision

A host starts one server. Teammates open the site link, pick a name, and land in a lobby of rooms. Each room points at a git repo on the host. Inside a room everyone sees the coding agents working live, each on its own branch and worktree, and talks in the room chat. When an agent hits a real design decision, it becomes a timed team vote. Routine permission requests go only to the person who started that agent. A signal strip shows which agents touch the same files and which would actually conflict when merged.

Agents run on the host's machine with the host's logins. There is no cloud sandbox, no database and no accounts.

## Prerequisites

- Node.js 22 or newer (tested on 24.3)
- Git 2.38 or newer (merge-conflict detection uses `git merge-tree --write-tree`; tested on 2.46)
- At least one agent. Each is detected at startup, and its real model list is loaded:

| Agent | Needs | Auth used |
|---|---|---|
| **Claude** (Agent SDK) | nothing extra | your Claude Code login, or `ANTHROPIC_API_KEY` in `.env` |
| **Codex CLI** | `npm i -g @openai/codex` | your Codex CLI login (`codex login`, ChatGPT or API key) |
| **Gemini CLI** | `npm i -g @google/gemini-cli` | `GEMINI_API_KEY` in `.env`, or your Gemini CLI Google login |
| **Gemini API** | `GEMINI_API_KEY` in `.env` | the API key |
| **OpenAI API** | `OPENAI_API_KEY` in `.env` | the API key |
| **Mock** | `--allow-mock` | none (scripted, no AI) |

- Optional, for remote teammates: [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (`winget install Cloudflare.cloudflared`).

## Setup and launch

```bash
npm install
cp .env.example .env          # optional; add keys or change defaults
npm start                     # lobby only
npm start -- --repo /path/to/repo   # also creates a starter room for that repo
```

`npm start` builds the web client and starts the server on `127.0.0.1:3003`. It lists the detected agents and prints two links:

- **Host:** includes the host key (`&h=…`). Open this one yourself. The host is admin in every room and is never blocked by a room's max people. The key is removed from the address bar after it loads.
- **Teammates:** the site link (`#k=…`). Share it with your team.

The site key travels in the URL fragment, which is never sent in HTTP requests, so it doesn't end up in access logs.

Flags: `--repo <path>` (starter room), `--base <branch>`, `--lan`, `--port`, `--host`, `--tunnel`, `--allow-mock`. Every flag has an environment-variable equivalent in `.env.example`. Per-agent default models: `CLAUDE_MODEL`, `CODEX_MODEL`, `GEMINI_CLI_MODEL`, `GEMINI_MODEL`.

### Rooms, passwords and roles

From the lobby, anyone with the site link can create a room. A room has:

- a **repo path** on the host machine (any folder that is a git repo with at least one commit) and an optional base branch;
- an optional **password**, stored as a scrypt hash and never sent to clients;
- **max people** (the host doesn't count against it);
- the **role** new members get.

| Role | Can |
|---|---|
| viewer | watch agents, chat |
| voter | + vote on team decisions |
| editor | + start agents (choosing agent and model) and prompt, end or cancel their own |
| admin | + change roles, remove people (they can't rejoin), end or cancel any agent, end or close the room |

The room creator is admin. Members who already joined can come back without the password. **End room** stops all agents and shows the recap. **Close room** also removes the room from the lobby and cleans up its worktrees.

### Your own API keys

Anyone can open **your api keys** (in the lobby, or the **keys** tab in a room) and add their own Anthropic, OpenAI or Gemini key. The server checks the key by listing the vendor's models and shows the result, for example `[ok] AIza…1234 · 23 models`. When that person spawns an agent, they choose who pays: **host** or **my key**. With their key, the model list is the one their key can access.

| Key | Runs |
|---|---|
| Anthropic | Claude agents |
| OpenAI | OpenAI API agents |
| Gemini | Gemini CLI and Gemini API agents |

Keys are kept in the host server's memory for that person only. They are never written to disk, never broadcast, and never sent back except masked. They are forgotten when the server restarts. A personal key is passed only to that person's agent process, and the host's own credentials are not passed alongside it. Codex CLI only supports a global login, so it always uses the host's login. Because the host machine runs the agent, the host can technically see the key; the UI says so.

### Teammates on the same network

By default the server listens on `127.0.0.1`, which only works on the host machine. For teammates on the same Wi-Fi or LAN:

```bash
npm start -- --lan
```

This listens on all interfaces and prints a teammate link for each real network adapter, such as `http://192.168.1.20:3003/#k=…`. If a teammate can't connect, check that the host's network is set to **Private** in Windows and that Node.js is allowed through Windows Firewall. Some guest and hotel networks block device-to-device traffic entirely; use `--tunnel` there. `ping` is not a useful test, because Windows blocks ICMP by default even when the app is reachable. Open `http://<host-ip>:3003/healthz` instead; it should return `{"ok":true}`.

### Teammates over the internet

```bash
npm start -- --tunnel
```

This starts a Cloudflare quick tunnel and prints a `https://….trycloudflare.com/#k=…` teammate link. The tunnel origin is added to the allowed origins automatically.

> The tunnel path has not been tested end to end on this machine because `cloudflared` is not installed here. Anyone holding the site link can create rooms that point agents at folders on the host, so share it only with people you trust with your machine.

## Demo (2 minutes)

```bash
npm run demo:setup            # creates .demo/todo-app, a fixture repo separate from your work
npm run demo                  # starts the server with a starter room on the fixture
```

1. The host opens the host link. Three teammates open the teammate link and enter names. The link drops them straight into the demo room.
2. Each person spawns one agent using the **demo** buttons (storage, rebrand: taskforge, rebrand: todopro) and picks Claude, Codex CLI or Gemini CLI.
3. The Storage agent asks "Which database should the todo app use?". A cyan decision card with a 30-second fuse appears on every screen, and the chat logs it. Vote. The agent resumes and writes the choice into `README.md`.
4. Storage and TaskForge both edit `README.md`, at the end and the top. The signal strip shows an amber **Shared file** row that "merges cleanly so far".
5. The two Rebrand agents set `APP_NAME` to different values. Both lamps turn red with a verified **Merge conflict** on `src/config.js`.
6. An admin clicks **end room** and confirms. Everyone sees the recap.

**Backup plan.** Restart with `npm run demo -- --allow-mock` and choose **Mock (scripted, no AI)**. The demo buttons then fill in deterministic scripts that go through the same votes, policy, worktrees and drift tracker. Mock sessions are labelled `mock`. Also record a screen capture of a successful live run beforehand.

## How it works

```
browser ─WebSocket (site key, origin, schema, rate checks)─▶ transport ─▶ app: identities, lobby
                                                                           │
                                                          room runtime (roles, password, chat) ×N
                                                                           │
             room state ◀─ shared reducer ◀─ events ◀──────────────────────┤
                                                                           ├─▶ session manager ─▶ agent adapters
                                                                           │        │   Claude SDK · Codex app-server · Gemini CLI (ACP) · Gemini API · mock
                                                                           │        └─▶ policy ─▶ vote engine (team votes / owner decisions)
                                                                           ├─▶ MCP endpoint (ask_team for CLI agents, loopback only)
                                                                           └─▶ drift tracker ─▶ git (temp-index snapshots, merge-tree)
```

| Module | Responsibility |
|---|---|
| `shared/protocol.ts` | Zod schemas for every message; validated on server and client |
| `shared/reducer.ts` | The single room-state transition function, used by both server and browser |
| `server/app.ts` | Identities, lobby, room creation and routing |
| `server/roomRuntime.ts` | One room: members, roles, password, chat, authorization |
| `server/votes.ts` | Vote state machine; transport-independent |
| `server/policy.ts` | Deny-by-default tool and command policy (bash and PowerShell) |
| `server/agents/*` | Agent adapters; all SDK- and CLI-specific code lives here |
| `server/mcp.ts` | Minimal MCP server that gives CLI agents the `ask_team` tool |
| `server/sessions.ts` | Worktrees, agent lifecycle, and the bridge from agent events to room state |
| `server/drift.ts` | Overlap and conflict detection |
| `web/src/*` | React client: lobby, room, chat, people, votes |

### Agents

| | Claude | Codex CLI | Gemini CLI | Gemini API |
|---|---|---|---|---|
| How it runs | Agent SDK `query()` | `codex app-server` (JSON-RPC over stdio) | `gemini --acp` (Agent Client Protocol) | host function-calling loop |
| Team questions | `AskUserQuestion` via `canUseTool` | `ask_team` dynamic tool, plus Codex's `requestUserInput` | `ask_team` via the host MCP endpoint | `ask_team` function |
| Permission interception | `canUseTool` on every tool call | command and file-change approval requests | `session/request_permission` | host tools, every call |
| Runs without asking the host | reads inside the worktree | commands Codex itself rates safe (read-only), inside its `workspace-write` sandbox | its own read-only tools inside the workspace | nothing |
| Models | Opus 5.5, Sonnet 5.5, Haiku 4.5, Fable 5.1 | from `model/list` | from `session/new` | from the models API |
| Verified live | `npm run poc`, `npm run live:e2e` | `scripts/poc-codex.ts`, `live:e2e -- --provider codex` | `scripts/poc-gemini-cli.ts`, `live:e2e -- --provider gemini-cli` | `live:e2e -- --provider gemini-api` |

Agent replies are rendered as Markdown (GitHub-flavored). Raw HTML in agent output is never rendered, unsafe link schemes are stripped, links open in a new tab, and remote images are shown as links.

Every agent is told to use its question tool for genuine team decisions and never for progress updates. Plain-text questions are never turned into votes.

**Claude SDK contract (verified against `@anthropic-ai/claude-agent-sdk` 0.3.288).** `canUseTool(toolName, input, { signal, toolUseID, … })` returns `{ behavior: "allow", updatedInput }` or `{ behavior: "deny", message }`. For `AskUserQuestion`, the answer goes back as `updatedInput = { ...input, answers: { [questionText]: chosenLabel } }`.

### Decisions: team votes and owner decisions

**Team votes** are used for design questions from agents.

- Voter, editor and admin roles vote; viewers watch. One ballot per person; re-votes, unknown options and late votes are rejected. Ballots are private; only counts are broadcast.
- Voting closes at the 30-second deadline, or early once every online voter has voted. A strict majority wins.
- On a tie or no votes, the agent's owner chooses within `COLAB_OWNER_WINDOW_SECONDS` (default 30). If the owner is offline or doesn't choose, the result is **no decision**: the agent is told to pick the most reversible option and state its assumption.
- Openings and results are posted in the room chat.

**Owner decisions** are used for routine permission requests, such as an agent wanting to run a command that isn't on the allowlist.

- Only the agent's owner sees the card and decides. Approve allows that one call.
- No answer within 30 seconds, or an owner who is offline, means **deny**. A fallback never approves anything.

Each decision resolves exactly once. Cancelling an agent cancels its pending decisions.

### Permission policy

The host policy decides first. A decision can only approve something the policy put up for one.

| Decision | Examples |
|---|---|
| Allow (no prompt) | File reads and edits inside the session worktree; allowlisted commands such as `ls`, `cat`, `rg`, `git status/diff/log/add/commit`, `npm test`, `npm run <script>`, `npx tsc/vitest/jest`, `node <file>`; read-only PowerShell such as `Get-Content`, `Get-ChildItem`, `Test-Path` and `Select-String`. Chains and pipes made only of these are allowed, plus `2>&1` and `>/dev/null`. |
| Owner decides | Any other command, such as `npm install x`, `Set-Content`, other redirects, `xargs` or PowerShell script blocks |
| Deny (nobody can override) | Paths outside the worktree, `.git/`, `.env`; `sudo`, `rm -rf`, `Remove-Item -Recurse`, network tools (`curl`, `Invoke-WebRequest`, `Invoke-RestMethod`, .NET web clients), `git push/reset --hard/clean/config/worktree`, environment inspection (`env`, `$env:`), nested shells, `Invoke-Expression`, `Start-Process`, command substitution, `~`, `..`, background processes, MCP tools, web fetch and search, sub-agents |

Codex shell commands arrive wrapped (`pwsh.exe -Command '…'`) and are unwrapped before the policy checks them. API keys are only passed to the agent process that needs them.

### Drift tracking

Every 10 seconds, and right after any agent finishes a turn, each worktree is snapshotted without being touched:

1. The worktree's index is copied to a temp file and `GIT_INDEX_FILE` is pointed at the copy.
2. `git add -A` runs into the temp index. It respects `.gitignore` and picks up untracked files.
3. `git write-tree` and `git commit-tree` produce a commit that is stored under the disposable ref `refs/colab/snapshots/<session>`.

The working files, real index, HEAD and branches are never modified. Tests verify this with `git status --porcelain=v2` before and after.

The changed files for a session are `git diff --name-status -M <merge-base(base, snapshot)> <snapshot>`. They include added, modified, deleted, renamed and untracked files. The merge-base is recomputed every scan, so the comparison follows `main` as it advances.

- **Amber (Shared file):** two or more sessions changed the same path.
- **Red (Merge conflict):** `git merge-tree --write-tree` on the two snapshots exits 1. Only pairs that share a path are checked. Overlap alone is never shown as a conflict.
- **Dashed lamp:** not scanned yet, scan failed (the error is in the tooltip), or stale (no scan in the last 25 seconds). The strip always shows when the last scan was verified.

Limitation: directory/file conflicts between sessions that share no path are not detected. Branches are never merged automatically.

### Recap

Lists objective indicators only: status, duration, files changed (from the final drift snapshot), commits on the session branch, test-command outcomes (denied test commands are not counted), decisions by resolution reason, votes cast per person, and unresolved conflicts. It does not claim an agent "shipped" anything.

## WebSocket protocol

Connect to `/ws` with subprotocols `["colab.v2", "token.<siteKey>"]`. The server rejects a missing or wrong key (401), a foreign `Origin` (403), or too many connections (503). Frames are JSON, at most 64 KB, and rate-limited per connection (burst 40, 20/s).

Every message uses one envelope:

```ts
{ type, eventId, timestamp, roomId?, sessionId?, payload }   // room state events also carry `seq`
```

**Lobby (client → server):** `hello {name, participantId?, secret?, hostKey?}`, `room.create {name, repoPath, baseRef?, password?, maxPeople, defaultRole}`, `room.join {roomId, password?}`, `room.leave`.

**Room (client → server):** `presence {viewingSessionId}`, `chat.send {text}`, `session.create {title, task, provider, model?}`, `session.prompt`, `session.cancel`, `session.end`, `vote.cast {voteId, optionId}`, `vote.resolve` (owner, after a tie or no votes), `member.role {participantId, role}` and `member.kick {participantId}` (admin), `snapshot.request`, `room.end` and `room.close` (admin).

**Room state events** (applied by `shared/reducer.ts`, ordered by `seq`): `participant.upsert`, `participant.remove`, `session.upsert`, `transcript.append`, `transcript.delta`, `transcript.update`, `vote.upsert`, `chat.message`, `drift.report`, `recap`, `room.ended`.

**Direct messages:** `lobby {participantId, secret, isHost, rooms, providers}`, `lobby.rooms {rooms}`, `welcome {roomId, role, myVotes, state}`, `snapshot`, `room.left {reason: left|kicked|closed}`, `vote.ack`, `error {code, message, replyTo}`.

**Reconnect:** the client says hello again with its saved `participantId` and `secret`, rejoins its room (members don't need the password again), and receives a full snapshot. The reducer ignores any event whose `seq` it has already applied. Ballots are keyed by participant on the server, so reconnecting can never duplicate a vote. A wrong secret gets a new identity, never someone else's.

## Security model and limitations

- **Agents run with the host's user account and the host's AI logins. Git worktrees are not a security sandbox.** The path checks confine the agents' *file tools*. A shell command is a separate process, and the command policy is a best-effort, deny-by-default allowlist, not OS isolation. Codex additionally runs commands in its own `workspace-write` sandbox; the other agents have no OS-level sandbox.
- **This design is for a trusted team, not the open internet.** Anyone with the site link can create a room on any git folder of the host and spend the host's AI quota. Don't post the site link publicly.
- Site keys and host keys are 256-bit random values compared in constant time. Room passwords are scrypt-hashed. Participant secrets prevent identity spoofing between people who share the site link.
- Everything is authorized on the server: roles, session ownership, owner-only decisions, admin actions. Watching a session grants no control.
- API keys stay on the host and are only passed to the agent process that needs them. The policy blocks environment inspection and secret expansion. Tool output shown in the UI has host paths replaced with `.`.
- The MCP endpoint that serves `ask_team` to CLI agents accepts loopback connections only, at a random per-session URL.
- The web client is served with a strict CSP, `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`.

## Cleanup

On shutdown (Ctrl+C), the host stops agents, cancels open votes, removes worktrees that have no uncommitted changes, and deletes snapshot refs. Worktrees with uncommitted work are **kept** so nothing is lost, and their location is logged. Session branches (`colab/*`) are always kept.

```bash
npm run cleanup -- --repo /path/to/repo          # list colab worktrees, branches and refs
npm run cleanup -- --repo /path/to/repo --yes    # remove them (uncommitted work is lost)
```

## Testing

```bash
npm test             # unit, integration and browser tests (mock agents; no API usage)
npm run typecheck
npm run poc                                   # LIVE: one Claude agent; question intercepted, answered, resumed
npx tsx scripts/poc-codex.ts                  # LIVE: Codex app-server dynamic tool + approvals
npx tsx scripts/poc-gemini-cli.ts             # LIVE: Gemini CLI ACP + MCP ask_team + permissions
npm run live:e2e -- --provider claude         # LIVE: full demo flow, three agents, three participants
npm run live:e2e -- --provider codex          #   (also gemini-cli, gemini-api; add --model <id>)
```

| Suite | Covers |
|---|---|
| `test/votes.test.ts` | Majority, early close, tie, no votes, owner absent or timeout, reconnect grace, duplicate, invalid and late votes, exactly-once resolution, malformed options, concurrent decisions, cancellation, ballot privacy, owner-only decisions |
| `test/policy.test.ts` | Worktree confinement, Windows/Git Bash paths, allow/owner/deny classes, quote-aware command splitting, real commands seen from Claude and Codex (bash and PowerShell), shell-wrapper unwrapping, Gemini CLI permission mapping |
| `test/drift.test.ts` | Untracked, deleted and renamed files; clean overlap vs real conflict; worktrees untouched; refs cleaned; base advancing; per-session errors |
| `test/server.test.ts` | Site key and origin rejection, validation, non-git folders, room passwords, lobby listing without secrets, three worktrees and branches, streaming, vote and resume, reconnect without duplicate votes, unknown models, chat, owner-only permissions, ownership, roles (viewer, voter, editor, admin), max people and host exemption, kicking, conflict alerts, owner-offline deny, cancellation, recap, room close and cleanup |
| `test/mcp.test.ts` | MCP handshake, `ask_team` routing, rejected questions, unknown tokens and tools, disposal |
| `test/gemini.test.ts` | Gemini API loop against a **stubbed** API: tool calls, `ask_team`, policy enforcement, key never leaked |
| `test/browser.test.ts` | Three headless Chrome/Edge profiles: lobby, room creation, deep link with password prompt (wrong then right), join from list, chat, vote by clicking, role change, amber and red lamps, recap, phone width (skipped if no Chrome/Edge or no build) |

| `test/keys.test.ts` | Key checks against **stubbed** vendor APIs, model filtering, masking, privacy (never echoed or shared), own-key sessions get the owner's key and model list, clearing keys |

Integration and browser tests use the **mock** provider. Real agents are verified only by the live scripts above (`--own-key` runs the agents on participant keys with the host key removed). Last live results on this machine: Claude, Codex CLI, Gemini CLI and Gemini API each passed all demo checks; Gemini API and Gemini CLI also passed in own-key mode. The OpenAI API agent and own Anthropic/OpenAI keys are tested only against stubbed APIs; no OpenAI or Anthropic API key was available here.

## Troubleshooting

- **"Web client not built"**: run `npm run build`, or use `npm start`, which builds first.
- **Browser shows "Can't join"**: the link is missing `#k=…`, the server was restarted (keys change on every start), or the page is served from an origin that isn't allowed. For LAN or VPN access, add your origin to `COLAB_ALLOWED_ORIGINS`.
- **Claude sessions fail immediately**: check that `claude` works in a terminal, or set `ANTHROPIC_API_KEY`. Logs go to stderr as JSON lines (`COLAB_LOG_LEVEL=debug` for more).
- **Agent keeps getting denied**: read the denial reason in the tool row. Commands that need a vote show a Permission card. Hard-denied commands can't be approved by design.
- **Red lamp never appears**: check `git --version` is 2.38 or newer, or that `COLAB_CONFLICT_CHECK` isn't `0`. The strip says "conflict check off" when it's disabled.
- **Leftover worktrees after a crash**: `npm run cleanup -- --repo <path>`.
