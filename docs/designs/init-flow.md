# InitFlow Design

Interactive `/init` command: presents a Feishu card with pre-defined repositories, collects user's repo+branch selections via a form submit, then clones, checks out, and binds the group workspace in one shot.

Specialized, **not** generic — no broader "interactive card framework". Only `/init` triggers this path.

## Dependencies

- `src/shared/config/schema.ts` — new `PredefinedRepo` and optional top-level `predefined_repos`
- `src/community/feishu/messaging/types/interactive/` — new element types (form, checker, input, button, column_set, select_static)
- `src/community/feishu/messaging/message-channel.ts` — subscribe `card.action.trigger`, emit `card:action`, expose `sendRawCard` and `updateRawCard`
- `src/shared/messaging/message-channel.ts` + `message-gateway.ts` — add `"card:action"` event type
- `src/kernel/workspaces/store.ts` — reuse `upsertBinding`, `resolve`
- `src/kernel/kernel.ts` — special-case `/init` like `/stop`; subscribe `card:action`

## Config

```yaml
predefined_repos:
  - name: agentara
    description: 7x24h personal assistant
    git_url: https://github.com/xluos/agentara.git
```

`predefined_repos` is optional. When unset or empty, `/init` replies with an error asking the operator to configure the catalog.

## Card Shape

Single Feishu Card 2.0 form with one row per predefined repo. Each row is a `column_set` with:
- `checker` — `name: repo_<name>`, label is the repo name
- `input` — `name: branch_<name>`, `placeholder: master`, no default value (empty submission means master)
- `markdown` — description text

Below the rows: a `select_static` for primary-repo selection (`name: primary_repo`, options built from the catalog), always shown.

Footer: `button` with `action_type: form_submit`, `behaviors.callback.value = { action: "init_submit", init_id }`.

## Events

`FeishuMessageChannel` adds a third event handler `card.action.trigger`. It normalizes the SDK payload into a minimal shape:

```ts
interface CardActionPayload {
  message_id: string;
  action_name: string;                // action.value.action
  init_id?: string;                   // action.value.init_id
  operator_open_id: string;           // who clicked
  form_value: Record<string, unknown>;// input/checker values on form_submit
  chat_id: string;
}
```

Emits as `card:action` on the channel; `MultiChannelMessageGateway` re-emits; kernel dispatches by `action_name` (only `"init_submit"` recognized).

## API

### `InitFlow` (src/kernel/init/init-flow.ts)

```ts
class InitFlow {
  constructor(deps: {
    workspaceStore: GroupWorkspaceStore;
    feishuChannels: Map<string, FeishuMessageChannel>; // by channel_id
    logger: Logger;
  });

  // Entry: called from kernel._handleInboundMessage when text === "/init"
  start(message: UserMessage): Promise<void>;

  // Entry: called from kernel card:action listener when action_name === "init_submit"
  handleSubmit(payload: CardActionPayload): Promise<void>;
}
```

### Pending state

In-memory `Map<messageId, PendingInit>` on the `InitFlow` instance:

```ts
interface PendingInit {
  chat_id: string;
  initiator_open_id: string;
  catalog_snapshot: PredefinedRepo[]; // frozen at card render time
  created_at: number;
}
```

Lost on kernel restart — acceptable. On submit for an unknown `message_id`, update the card in place with an "expired, please re-run /init" message.

## Error Handling

- `/init` when `predefined_repos` is unset/empty → text reply: ask operator to configure.
- `/init` when the group is already bound (`upsertBinding` already present) → text reply: `已绑定 <repo>@<branch>，请先 /unbind`.
- `/init` outside Feishu (`!message.chat_id`) → text reply: `/init 仅在飞书群内可用`.
- Submit by non-initiator → update card: `这不是你的表单`.
- No repos selected on submit → update card: `未选择任何仓库`.
- Per-repo clone failure → keep successful clones, record the failed entry; show per-repo status in result card.
- Per-repo checkout failure → keep the clone, leave `active_branch` unset if that repo becomes primary; warn on the card.
- All throws from the submit path → update card with `❌ 初始化失败: <err>`.

No silent fallback. No graceful retry. Every failure surfaces on the card.

## Concurrency / Constraints

- Single-writer to pending state: all access through one `InitFlow` instance on the kernel.
- One pending init per `chat_id` — a second `/init` while another is pending replaces the first card's pending entry (in-memory map is keyed by `message_id`, so earlier card becomes unreachable and effectively expired).
- Clone operations run sequentially within one submit, keeping output deterministic and avoiding concurrent writes to the same workspace directory.
- Primary-repo select always offers the full catalog (not just checked rows). If the primary isn't among the checked rows on submit, treat submit as invalid and update card.

## Result Card

After submit completes (success or partial), the original card is replaced with a result card (via `updateRawCard`) showing per-repo status (`✅ cloned` / `⚠️ checkout failed` / `❌ clone failed`), the final binding, and next-step hints.
