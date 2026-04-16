import { z } from "zod";

/**
 * A persisted per-group workspace binding.
 *
 * Each Feishu group that has been bound via `/bind` or `/init` owns one row.
 * The workspace directory is always `$AGENTARA_HOME/workspaces/<chat_id>/`
 * and may host multiple cloned repos as first-level subdirectories. The
 * active `(repo, branch)` pointer is what `_handleInboundMessageTask` reads
 * to decide cwd and `DEV_ASSETS_PRIMARY_REPO` env extras.
 */
export const GroupWorkspace = z.object({
  /** Feishu chat id. */
  chat_id: z.string(),
  /** Absolute path of the workspace root. */
  workspace_path: z.string(),
  /** Basename of the active repo under the workspace root, or null. */
  active_repo: z.string().nullable(),
  /** Git branch the active repo should be on at dispatch, or null. */
  active_branch: z.string().nullable(),
  /** Epoch ms when the binding was created. */
  created_at: z.number(),
  /** Epoch ms when the binding was last updated. */
  updated_at: z.number(),
});
export interface GroupWorkspace extends z.infer<typeof GroupWorkspace> {}
