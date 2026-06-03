# Group Workspace Binding Design

Enable one agentara bot to serve multiple Feishu groups. Each group binds to its own workspace (a multi-repo directory) with an active `(repo, branch)` pointer. Every Feishu topic inside a group becomes an isolated session that follows the group's live binding.

## Goals

- One bot process, N Feishu groups — registered dynamically at runtime
- Per-group workspace directory (can host multiple cloned repos, all visible to the agent in one session)
- Per-topic session within a group (flexible + isolated)
- Gateway-level slash commands that bypass the LLM
- Default workspace fallback when a group is not bound
- `dev-assets` memory works across all repos in the workspace (requires the suite-side workspace mode — see `branch-context-skill-suite/docs/workspace-mode.md`)

## Non-Goals

- Per-topic workspace override (binding lives at group level only)
- Multiple simultaneously-active repos inside one workspace
- Rich card UI for `/setup` in v1 (text commands first, card in v2)

## Data Model

### `group_workspaces` (new table)

| Field | Type | Notes |
|-------|------|-------|
| `chat_id` | text, PK | Feishu `chat_id` |
| `workspace_path` | text | Absolute path, always `$AGENTARA_HOME/workspaces/<chat_id>/` |
| `active_repo` | text, nullable | Directory name under `workspace_path` |
| `active_branch` | text, nullable | Git branch name |
| `created_at` | int | epoch ms |
| `updated_at` | int | epoch ms |

Row absence = group is unbound. `active_repo = null` while `workspace_path` exists = workspace reserved but no repo selected yet.

### `sessions` (schema extension)

Add two fields to the existing `Session` schema (`src/shared/sessioning/types/session.ts`):

- `chat_id: string | null` — owning Feishu group
- `thread_id: string | null` — Feishu topic root message id

Keep `cwd` for backward compatibility, but **it is now a hint, not a source of truth**. Actual cwd is resolved dynamically on every dispatch (see Resolution Flow).

### Default workspace

Path: `$AGENTARA_HOME/workspaces/_default/`

Created by boot-loader on first run. Used when a message arrives from an unbound group or from a group whose binding has `active_repo = null`.

## Feishu Channel Rework

### Current (`src/kernel/kernel.ts:87-99`)

`config.yaml` lists each Feishu channel; one `FeishuMessageChannel` instance per chat, constructor-bound to a specific `chat_id`. Adding a group = editing config + restart.

### New

- Exactly one `FeishuMessageChannel` instance, **no `chat_id` filter**
- Subscribes to all group events the bot is a member of (Feishu WS IM event stream already broadcasts to the bot user; filter only on event type, not chat)
- Inbound event carries `chat_id` + `root_id` (topic id when the message is inside a topic; equals message id otherwise)
- `UserMessage.channel_id` remains the agentara internal channel id (single value for the one Feishu channel); the Feishu `chat_id` and `root_id` are carried as new fields on `UserMessage`

### Session id derivation

```
session_id = `feishu:${chat_id}:${thread_id}`
```

- First message inside a topic → `resolveSession` creates
- Subsequent messages in same topic → `resolveSession` resumes
- Messages outside any topic (direct `@mention` with no threading) → treated as topic whose `thread_id = message_id` (each becomes its own fresh session; encourages the bot to always reply in a topic so follow-ups resume correctly)

## Gateway Commands

Parsed in `Kernel._handleInboundMessage` (`src/kernel/kernel.ts:114`) before `TaskDispatcher.dispatch()`. Prefix: `/` (matches Claude Code convention). Commands execute synchronously, reply via `_messageGateway.replyMessage`, do not dispatch an LLM task.

| Command | Scope | Effect |
|---------|-------|--------|
| `/setup` | group | Reply with an interactive card. User picks repo + branch; card submit writes group binding. v1 may fall back to `/bind`. |
| `/bind <repo> <branch>` | group | Upsert `group_workspaces` row, set `active_repo` + `active_branch`. Rejects if `<repo>` not in workspace (suggests `/clone`). |
| `/unbind` | group | Delete `group_workspaces` row. |
| `/status` | group + topic | Show group binding, list cloned repos, show current topic's `session_id`. |
| `/clone <git-url> [name]` | group | `git clone` into `workspace_path`. Rejects on name collision. |
| `/checkout <branch>` | group | `git checkout` in active repo; updates `active_branch`. Rejects on dirty tree. |
| `/ls` | group | List directories under `workspace_path`. |
| `/new` | topic | Archive current session for this topic; next message opens a new session with the same `session_id` reset (or appends a generation suffix). |
| `/agent <claude\|codex>` | topic | Overrides `agent_type` for the current session only; re-resolve session with new runner type. |

Already-implemented reference: `/stop` (`src/kernel/kernel.ts:118`). Extend the same if-chain into a command table.

Card interaction for `/setup` should mirror the streaming card pattern in `remote_claude/lark_client/shared_memory_poller.py` + interactive element handling in Feishu card-action callbacks. Deferred to v2.

## Resolution Flow

Per inbound Feishu message:

1. `FeishuMessageChannel` emits `message:inbound` with `{ chat_id, thread_id, text, ... }`
2. `Kernel._handleInboundMessage`:
   - If text starts with `/` → dispatch to gateway command handler, reply, return
   - Else compute `session_id` from `(chat_id, thread_id)`
   - `TaskDispatcher.dispatch(session_id, { type: "inbound_message", message })`
3. `Kernel._handleInboundMessageTask`:
   - Load `group_workspaces` row for `chat_id`
   - Resolve cwd:
     - No row → `cwd = $AGENTARA_HOME/workspaces/_default/`
     - Otherwise → `cwd = workspace_path` (the workspace root, multi-repo container — **not** a single repo dir)
   - If `active_repo` set: pre-checkout `git -C <workspace_path>/<active_repo> checkout <active_branch>` (idempotent)
   - Build runner env extras:
     - If `active_repo` set: `DEV_ASSETS_PRIMARY_REPO=<active_repo>`, `DEV_ASSETS_PRIMARY_BRANCH=<active_branch>`
     - Else: omit (skill suite enters workspace mode without primary hint)
   - `SessionManager.resolveSession(session_id, { cwd, chatId, threadId, envExtras, firstMessage })`
   - `session.stream(message)` as today

The cwd passed to `resolveSession` on resume overrides the stored `cwd` (supported today at `src/kernel/sessioning/session-manager.ts:174`). This is the mechanism for "live binding": each dispatch re-resolves. `envExtras` is a new option threaded through to the runner's `Bun.spawn` call so per-group env vars reach the underlying CLI.

## dev-assets Integration

The cwd contract changed: cwd is the group's workspace root (`workspaces/<chat_id>/`), which is **not** a git repo but contains N cloned repos as first-level subdirectories. The native `dev-assets` skills assume cwd is inside a single git repo, so the suite needs an additive **workspace mode**. Suite-side design lives in `branch-context-skill-suite/docs/workspace-mode.md`. Summary:

- `lib/dev_asset_common.py` gains `detect_workspace_mode()` + `list_repos_in_workspace()` (purely additive)
- Hook scripts (`session_start.py`, `stop.py`, `pre_compact.py`, `session_end.py`) take a workspace branch: when cwd has no `.git` but first-level subdirs do, iterate all repos
- Single-repo cwd behavior is unchanged; existing installations see no difference

### agentara-side contract

When dispatching, agentara passes to the runner:

- `cwd = workspaces/<chat_id>/` (workspace root)
- env `DEV_ASSETS_PRIMARY_REPO=<active_repo>` (basename) — focus repo from group binding
- env `DEV_ASSETS_PRIMARY_BRANCH=<active_branch>` — informational

The skill suite then:

- **SessionStart**: full memory for primary repo + brief overview-only summary for other repos in workspace
- **Stop / SessionEnd**: record HEAD for all repos in workspace (cheap, idempotent)
- **dev-assets-sync** (LLM-invoked): defaults to primary when no `--repo` flag; LLM can pass `--repo=<name>` to write to another repo
- **dev-assets-context** (LLM-invoked): can target a non-primary repo via `--repo=<name>` to load its full memory mid-session

Codex parity: SessionStart + Stop hooks fire identically. Codex lacks PreCompact/SessionEnd, but those don't affect multi-repo correctness — only Claude-only checkpoint refinement.

### Default workspace

For `_default` (no binding): no `DEV_ASSETS_PRIMARY_REPO` set. Suite enters workspace mode and lists whatever repos the user happens to have cloned in there. Empty `_default` → suite no-ops (acceptable).

### Cross-group memory sharing

Memory is keyed by `(repo_identity, branch)` derived from git remote URL (or local path fallback). Two groups bound to the same `(repo, branch)` automatically share memory under `~/.dev-assets/repos/<repo-key>/branches/<branch-key>/` — no agentara code involved.

## Concurrency & Ordering

- Same `(chat_id, thread_id)` → same `session_id` → serial execution via `TaskDispatcher`'s per-session queue (existing guarantee).
- Different topics in same group → different `session_id` → parallel execution (existing guarantee).
- `/checkout` interleaved with an in-flight LLM turn in another topic of the same group: the running runner's `cwd` (workspace root) is unchanged, but the active repo's HEAD shifts under it. Tool calls touching `<workspace>/<active_repo>/**` may see the new branch's files mid-turn. Acceptable per Q6(b) — live binding is the user's explicit choice. Other repos in the workspace are unaffected.
- Two simultaneous `/checkout` on same group: serialize via a per-chat mutex in the gateway command layer (reuse `TaskDispatcher` isn't right — commands are synchronous). Simple `Map<chat_id, Promise>` mutex.

## Error Handling

Strict; no silent coercion.

- `/bind <repo> <branch>` where `<repo>` directory absent → reply with suggestion to run `/clone`.
- `/clone` with name collision → reject.
- `/checkout` on dirty tree → reply with `git status --short` output; require user to resolve manually.
- `/unbind` when no row → reply "group is not bound".
- Inbound message from group with no binding → silently fall back to `_default`, no error.
- Feishu event missing `chat_id` → log error, drop event.
- Gateway command execution failure → reply with error text; do not dispatch LLM fallback.

## Config Changes

`config.yaml`:

- `messaging.channels` entries for Feishu no longer need `chat_id` (ignored if present, logged as deprecation)
- Add optional `messaging.default_workspace_path` to override `$AGENTARA_HOME/workspaces/_default/`

No breaking change for users with existing single-chat config — a missing `chat_id` is now valid and means "listen to all groups".

## Files Touched

| File | Change |
|------|--------|
| `src/shared/sessioning/types/session.ts` | Add `chat_id`, `thread_id` fields |
| `src/kernel/sessioning/data.ts` | Drizzle schema: add columns + new `group_workspaces` table |
| `src/kernel/sessioning/session-manager.ts` | Pass through new fields on create/resume |
| `src/kernel/workspaces/` (new dir) | `GroupWorkspaceStore` (CRUD over `group_workspaces`), cwd resolver |
| `src/kernel/commands/` (new dir) | Slash command parser + handlers |
| `src/community/feishu/messaging/` | Remove per-chat filter; forward `chat_id` + `root_id` on inbound |
| `src/kernel/kernel.ts` | Wire command parser into `_handleInboundMessage`; wire cwd resolver + env extras into `_handleInboundMessageTask` |
| `src/shared/agents/agent-runner.ts` | Add `envExtras?: Record<string, string>` to `AgentRunOptions` schema |
| `src/community/anthropic/claude-agent-runner.ts` | Merge `envExtras` into `Bun.spawn` env (preserve `ANTHROPIC_API_KEY: ""` clear for subscription auth) |
| `src/community/openai/codex-agent-runner.ts` | Merge `envExtras` into `Bun.spawn` env |
| `src/shared/messaging/types/message.ts` | Extend `UserMessage` with `chat_id`, `thread_id` optional fields |
| `src/boot-loader/boot-loader.ts` | Ensure `workspaces/_default/` exists on first run |
| `docs/overview.md` | Append "Group Workspace Binding" section linking here |

## Implementation Order

1. Schema additions (`group_workspaces` table, `Session` fields, `UserMessage` fields) + migration
2. `GroupWorkspaceStore` CRUD + cwd resolver
3. Feishu channel multi-group refactor (forward `chat_id` + `root_id`)
4. Session id derivation in kernel from `(chat_id, thread_id)`
5. Dynamic cwd resolution at dispatch
6. Slash command parser + core handlers (`/bind`, `/unbind`, `/status`, `/clone`, `/checkout`, `/ls`)
7. `/new`, `/agent` — session lifecycle commands
8. Default workspace bootstrap
9. v2: `/setup` Feishu card interaction

## Open Questions

- Feishu `root_id` behavior when the bot itself opens a topic vs when user does: verify the id is stable across the whole thread. (Implementation detail; does not change design.)
- `/new` semantics: does archiving mean deleting the JSONL or renaming? Propose rename to `<session_id>.archived-<ts>.jsonl` so the DB row is kept for audit. Decide during implementation.
