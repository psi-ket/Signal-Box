# Signal Box

**Run a team of coding agents. Decide together.**

Signal Box is a website where a team watches its coding agents work live, one room per project. When an agent hits a real design decision, it becomes a timed team vote. Risky commands go to the person who started that agent. A signal strip turns amber when agents touch the same file and red when Git confirms their changes won't merge.

```
 browser ──https──▶  HUB (hosted)                         RUNNER (each teammate's machine)
                     accounts · rooms · roles · chat  ◀──wss── npm run runner -- --hub … --token …
                     votes · owner approvals                  clones the room's Git URL (your Git access)
                     drift checks (bare mirror + patches)     one worktree + branch per agent
                     SQLite                                   Claude / Codex / Gemini / OpenAI
                                                              with your login or your own API key
                                                              deny-by-default tool policy
```

**The hub never runs agent code.** It stores accounts, rooms and chat. It relays tasks to runners, runs votes, and checks uploaded patches for conflicts. Agents run on each teammate's own **runner** with that person's credentials. This is what makes it reasonable to host the hub on the internet.

## Quick start (one machine, demo mode)

```bash
npm install
npm run demo:setup     # creates .demo/todo-app, a fixture repo
npm run demo           # hub + an in-process "host runner", local repo paths allowed
```

1. Open <http://localhost:3003> and **create an account**. The first account becomes the site admin.
2. In **new room**, use the fixture path printed by `demo:setup` as the Git URL, set an optional password, and create the room.
3. Teammates create accounts and join from the room list, or by opening the room's URL (`/rooms/<id>`). With `--lan`, use the address printed at startup.
4. Each person spawns an agent with the **demo** buttons (storage, rebrand: taskforge, rebrand: todopro), then votes and watches the signals.

In demo mode the **host runner** runs everyone's agents on the hub machine. That's convenient on one laptop or a trusted LAN, but it means anyone with an account can run agents on your machine. Don't use `--host-runner` or `--allow-local-repos` on a public hub.

## Hosting on the internet

```bash
npm install && npm run build
COLAB_PUBLIC_URL=https://signalbox.example.com npm run serve -- --host 0.0.0.0
```

- Put it behind HTTPS (Caddy, nginx, or a Cloudflare tunnel). Setting `COLAB_PUBLIC_URL` to an `https://` URL allows that origin and marks session cookies `Secure`.
- Data lives in `.data/` (SQLite database plus bare repo mirrors). Back it up. `COLAB_DATA_DIR` and `COLAB_DB_FILE` move it.
- `COLAB_REGISTRATION=closed` stops new sign-ups after the first (admin) account. `COLAB_ADMINS=alice,bob` makes those usernames site admins.
- Rooms take `https://`, `ssh://` or `git@host:owner/repo` URLs. Local paths are refused unless `--allow-local-repos` is set.

### Where to deploy

The hub is a long-running Node server. It holds WebSocket connections and writes SQLite and Git mirrors to disk, so it needs a host that runs a container or process with a **persistent volume**: Railway, Render, Fly.io, or any VPS. **Serverless platforms such as Vercel or Netlify can't run it.** They can serve the static page, but sign-up, rooms and runners need the server.

The included `Dockerfile` builds the client, installs `git`, listens on `$PORT` (or 3003), stores data in `/data`, and trusts the proxy's `X-Forwarded-For` for rate limits:

1. Create a service from this repository using the Dockerfile.
2. Attach a persistent volume at `/data`.
3. Set `COLAB_PUBLIC_URL=https://<your domain>`. Optionally set `COLAB_REGISTRATION=closed` once your team has signed up.

`.env` is excluded from the image, so no local keys end up in it. The hub needs no AI keys; those belong on runners.

## Connecting your runner

Your agents run on your machine. In **rooms → your runners**, give the runner a name and click **add runner**. The page shows a one-time command:

```bash
# in a checkout of Signal Box (git clone …; npm install)
npm run runner -- --hub https://signalbox.example.com --token sbr_…
```

The runner checks which agents your machine has and connects. Your rooms then show it as online, and your **spawn agent** panel unlocks. It:

- clones each room's Git URL into `~/.signalbox` with **your** Git credentials (private repos work if you can clone them);
- creates one worktree and branch (`colab/<name>-<id>`) per agent, so agents never share files;
- runs agents with **your** logins (Claude Code, Codex CLI, Gemini CLI) or with API keys from your environment or the **keys** panel;
- enforces the tool policy locally and asks you before anything outside the safe list;
- uploads changed-file lists and binary patches (not your files) so the hub can check for conflicts.

Revoking a token in the web app disconnects that runner immediately. Ctrl+C stops the runner and removes worktrees that have no uncommitted work. Branches with commits stay in the runner's clone.

| Agent | Needs on the runner | Uses |
|---|---|---|
| Claude (Agent SDK) | nothing extra | your Claude Code login, `ANTHROPIC_API_KEY`, or your own key from the keys panel |
| Codex CLI | `npm i -g @openai/codex`, `codex login` | your Codex login |
| Gemini CLI | `npm i -g @google/gemini-cli` | your Gemini login, `GEMINI_API_KEY`, or your own key |
| Gemini API | `GEMINI_API_KEY` or your own key | the key |
| OpenAI API | `OPENAI_API_KEY` or your own key | the key |
| Mock | `--allow-mock` | nothing (scripted, for tests and offline demos) |

### Your own API keys

The **keys** panel (in the lobby, or a tab in each room) accepts Anthropic, OpenAI and Gemini keys. A key goes from your browser through the hub to **your runner**. The runner checks it by listing the vendor's models, keeps it in memory, and shows it back only masked (`AIza…1234 · 23 models`). When you spawn an agent you choose **runner login** or **my key**, and the model list comes from what your key can access. The hub never stores keys. Other people never see them.

## Rooms, roles and chat

A room has a name, a Git URL and base branch, an optional password (stored as a scrypt hash), a maximum number of people, and the role new members get.

| Role | Can |
|---|---|
| viewer | watch agents, chat |
| voter | + vote on team decisions |
| editor | + spawn agents on their runner and prompt, end or cancel their own |
| admin | + change roles, remove people (permanently), end or cancel any agent, end or close the room |

The creator is admin. Site admins are admin everywhere and aren't limited by max people. Members don't need the password again. Memberships, roles, bans and chat history are stored in the database and survive restarts. Live agent transcripts and votes don't.

## Decisions

**Team votes** are used for design questions an agent asks through its question tool (`AskUserQuestion` for Claude, `ask_team` for the others). The card appears on every screen with a 30-second fuse.

- Voters, editors and admins vote, one ballot each. Ballots are private; only counts are shown.
- A strict majority wins. Voting closes early when every online voter has voted.
- On a tie or no votes, the agent's owner picks. If the owner is offline or doesn't pick in time, the agent is told no decision was reached and to choose the most reversible option.

**Owner approvals** cover commands outside the safe list. Only the agent's owner sees the card. No answer, or an offline owner, means **deny**.

**Policy** (enforced on the runner): file tools are confined to the agent's worktree. Allowlisted commands run without asking: reads, `git status/diff/log/add/commit`, `npm test`, read-only PowerShell, and pipes and chains made only of these. Anything else goes to the owner. Dangerous commands are denied outright, and no vote can override that: `rm -rf`, `sudo`, network tools, `git push/reset --hard`, environment inspection, `Invoke-Expression`, paths outside the worktree, `.env`, `.git`.

## Drift signals

Runners upload each agent's changed files and a binary patch against its base commit (every 10 seconds and after each turn). The hub keeps a bare mirror of the room's Git URL, rebuilds each agent's tree in a temporary index (`git apply --cached`), and runs `git merge-tree --write-tree` on agents that share a file.

- **Amber:** the same file was changed by two or more agents.
- **Red:** Git confirms the changes conflict. Overlap alone is never shown as red.
- **Dashed:** not reported yet, failed, or stale. The strip always shows when it was last verified.

If the hub can't read the repo (private, and the hub has no credentials), the strip still shows shared files and says why conflicts aren't verified. Branches are never merged automatically.

## Agent output

Replies render as Markdown (GitHub-flavored). Raw HTML from agents is never rendered, unsafe links are stripped, links open in a new tab, and remote images are shown as links.

## Security model

- **Accounts:** passwords are hashed with scrypt. Login sessions use an HttpOnly, SameSite=Lax cookie; the database stores only a SHA-256 of the session token. Logins are rate-limited per IP and per account, sign-ups per IP. Unknown usernames and wrong passwords return the same message.
- **CSRF:** state-changing API calls must be JSON and come from an allowed origin. WebSockets check the origin and the session.
- **Runners:** tokens are hashed in the database and shown once. A personal runner only runs its owner's agents and only holds its owner's keys. Runner messages are schema-validated, and runners can only affect sessions they run.
- **Git URLs** are validated (https/ssh/git only, no embedded credentials). Every clone and fetch blocks git's command-executing transports (`ext::`, `fd::`) with `GIT_ALLOW_PROTOCOL`.
- **Runner machines:** agents run as you, on your machine. Worktrees and the command policy limit what agents do, but they are not an OS sandbox (Codex additionally uses its own `workspace-write` sandbox). Run a runner only for rooms you trust.
- **Web client:** strict CSP, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`.

## Configuration

Hub flags: `--lan`, `--port` (default 3003), `--host`, `--tunnel`, `--data-dir`, `--host-runner`, `--allow-local-repos`, `--allow-mock`. Runner flags: `--hub`, `--token`, `--name`, `--data-dir`, `--allow-mock`, `--allow-local-repos`. Everything else is in `.env.example`.

## Testing

```bash
npm test                                      # 76 tests: units, hub+runner integration, browser (mock agents)
npm run typecheck
npm run live:e2e -- --provider claude         # LIVE: 3 accounts, 3 personal runners, real agents
npm run live:e2e -- --provider codex          #   also gemini-cli, gemini-api, openai-api
npm run live:e2e -- --provider gemini-cli --own-key   # agents billed to participants' own keys
npx tsx scripts/poc-ask.ts | poc-codex.ts | poc-gemini-cli.ts   # protocol proofs of concept
```

| Suite | Covers |
|---|---|
| `auth.test.ts` | Registration (first user admin, validation, duplicates), login/logout, cookie flags, no user enumeration, CSRF and content-type checks, login and sign-up rate limits, hashes-only storage, closed registration |
| `runner.test.ts` | Git URL safety, key checks (stubbed vendors), runner pairing with hashed tokens, agents run only on their owner's runner, keys held on the runner and never shown to others, own-key sessions, revocation fails live agents |
| `server.test.ts` | Hub + in-process runner: WebSocket auth and origin, room passwords, membership memory, worktrees per agent (paths never leak), team votes and resume, owner-only approvals, runner-side policy, roles, verified conflicts from patches, persistent kicks, max people, owner-offline deny, recap, persistence across restart, closing rooms |
| `votes.test.ts`, `policy.test.ts`, `drift.test.ts`, `mcp.test.ts`, `gemini.test.ts` | Vote state machine, bash and PowerShell policy, local snapshots, the MCP `ask_team` endpoint, the Gemini and OpenAI tool loops (stubbed APIs) |
| `browser.test.ts` | Headless Chrome/Edge: landing page and its animation, redirect to sign-in, sign-up, room creation from a Git URL, password prompt, joining from the list, chat, voting, Markdown, amber and red lamps, recap, sign-out, phone width |

**Last live results on this machine:** Claude, Codex CLI, Gemini CLI (with participants' own keys) and Gemini API each passed every check through personal runners. The OpenAI API agent and personal Anthropic/OpenAI keys are tested only against stubbed APIs, because no OpenAI or Anthropic API key was available here.

## Notes

- Requires Node.js 22.13+ (uses the built-in `node:sqlite`, which prints an "experimental" warning) and Git 2.38+.
- The runner is started from a checkout of this repository. Publishing it as an npm package would allow `npx signalbox-runner`; that isn't done yet.
- `npm run cleanup -- --repo <path> [--yes]` lists or removes leftover `colab/*` worktrees, branches and refs in a runner's clone.
