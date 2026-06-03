# SetupFlow Design

Interactive `/setup` command: presents a Feishu card with pre-defined repositories (sourced from `$AGENTARA_HOME/REPOS.md`), collects user's repo+branch selections via a form submit, then clones, checks out, and binds the group workspace in one shot.

Specialized, **not** generic — no broader "interactive card framework". Only `/setup` triggers this path. Day-to-day binding uses `/bind <repo> <branch>`.

## Dependencies

- `src/shared/config/predefined-repos.ts` — `PredefinedRepo` Zod schema + `loadPredefinedRepos()` Markdown parser
- `src/community/feishu/messaging/types/interactive/` — element types (form, checker, input, button, column_set, select_static)
- `src/community/feishu/messaging/message-channel.ts` — subscribes `card.action.trigger`, emits `card:action`, exposes `sendRawCard` and `updateRawCard`
- `src/shared/messaging/message-channel.ts` + `message-gateway.ts` — `"card:action"` event type
- `src/kernel/workspaces/store.ts` — reuses `upsertBinding`, `resolve`
- `src/kernel/kernel.ts` — special-cases `/setup` like `/stop`; subscribes `card:action`
- `src/boot-loader/boot-loader.ts` — seeds an empty `REPOS.md` on first boot and ensures CLAUDE.md references it

## Source — `$AGENTARA_HOME/REPOS.md`

The repo catalog lives in a Markdown file instead of `config.yaml` so the
same file can double as agent-readable context. CLAUDE.md imports it via
Claude Code's native `@REPOS.md` syntax; the boot-loader appends that
reference automatically if missing.

Each `## <name>` section defines one repo. The first `- git_url: <url>`
bullet supplies the clone URL; the first non-bullet prose line becomes
the one-line description rendered on the card. The rest of the section
body is free-form prose for the agent — and the agent is expected to
update those descriptions over time as it learns more about each repo.

```markdown
## agentara

- git_url: https://github.com/magiccube/agentara.git

Bun + TypeScript personal assistant. Useful when a group is discussing
the kernel, session/task orchestration, or Feishu bot integration.
```

When `REPOS.md` is missing or yields zero parseable entries, `/setup`
replies with an error pointing the operator at the file.

`loadPredefinedRepos()` is called on every `/setup` invocation — no
caching — so edits to the Markdown take effect immediately.

## Card Shape

Single Feishu Card 2.0 form with one row per predefined repo. Each row is a `column_set` with:
- `checker` — `name: repo_<name>`, label is `<name>` (plus `— <description>` when present)
- `input` — `name: branch_<name>`, `placeholder: master`, no default value (empty submission means master)

Below the rows: a `select_static` for primary-repo selection (`name: primary_repo`, options built from the catalog), always shown.

Footer: `button` with `name: "setup_submit"` and `action_type: form_submit`.

## Events

`FeishuMessageChannel` handles `card.action.trigger` and normalizes the SDK payload into a minimal shape:

```ts
interface CardActionPayload {
  message_id: string;
  action_name: string;                // button/element name (e.g. "setup_submit")
  operator_open_id: string;           // who clicked
  form_value: Record<string, unknown>;// input/checker values on form_submit
  chat_id: string;
}
```

Emitted as `card:action` on the channel; `MultiChannelMessageGateway` re-emits; kernel dispatches by `action_name` (only `"setup_submit"` recognized).

## API

### `SetupFlow` (`src/kernel/setup/setup-flow.ts`)

```ts
class SetupFlow {
  constructor(deps: {
    workspaceStore: GroupWorkspaceStore;
    feishuChannels: Map<string, FeishuMessageChannel>; // by channel_id
  });

  // Entry: called from kernel._handleInboundMessage when text === "/setup"
  start(message: UserMessage): Promise<void>;

  // Entry: called from kernel card:action listener when action_name === "setup_submit"
  handleSubmit(payload: CardActionPayload): Promise<void>;
}
```

### Pending state

In-memory `Map<messageId, PendingSetup>` on the `SetupFlow` instance:

```ts
interface PendingSetup {
  chat_id: string;
  initiator_open_id: string;
  catalog_snapshot: PredefinedRepo[]; // frozen at card render time
  created_at: number;
}
```

Lost on kernel restart — acceptable. On submit for an unknown `message_id`, the card is updated in place with an "expired, please re-run /setup" message.

## Error Handling

- `/setup` when `REPOS.md` is missing or empty → text reply: ask operator to fill in `REPOS.md`.
- `/setup` when the group is already bound (`upsertBinding` already present) → text reply: `已绑定 <repo>@<branch>，请先 /unbind`.
- `/setup` outside Feishu (`!message.chat_id`) → text reply: `/setup 仅在飞书群内可用`.
- Submit by non-initiator → update card: `这不是你的表单`.
- No repos selected on submit → update card: `未选择任何仓库`.
- Per-repo clone failure → keep successful clones, record the failed entry; show per-repo status in result card.
- Per-repo checkout failure → keep the clone, bind to whatever the clone landed on; warn on the card.
- All throws from the submit path → update card with `❌ 初始化失败: <err>`.

No silent fallback. No graceful retry. Every failure surfaces on the card.

## Concurrency / Constraints

- Single-writer to pending state: all access through one `SetupFlow` instance on the kernel.
- One pending setup per `chat_id` — a second `/setup` while another is pending replaces the first card's pending entry (in-memory map is keyed by `message_id`, so the earlier card becomes unreachable and effectively expired).
- Clone operations run sequentially within one submit, keeping output deterministic and avoiding concurrent writes to the same workspace directory.
- Primary-repo select always offers the full catalog (not just checked rows). If the primary isn't among the checked rows on submit, the handler falls back to the first checked row instead of rejecting.

## Result Card

After submit completes (success or partial), the original card is replaced with a result card (via `updateRawCard`) showing per-repo status (`✅ cloned` / `⚠️ checkout failed` / `❌ clone failed`), the final binding, and next-step hints.
