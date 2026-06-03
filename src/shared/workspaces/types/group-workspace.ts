import { z } from "zod";

import { Workspace } from "./workspace";

/**
 * A persisted per-group workspace binding, flattened for callers.
 *
 * Each Feishu group that has been bound via `/bind` or `/setup` owns one row
 * in `group_workspaces`, but the underlying workspace itself lives in the
 * separate `workspaces` registry so multiple groups can reference the same
 * directory by stable `workspace_id`. The store joins them and returns this
 * flattened shape so callers don't need to know the split.
 *
 * `active_repo`/`active_branch` come from the workspace row — groups sharing
 * a workspace see the same active state because only one `.git/HEAD` exists
 * per cloned repo. `created_at`/`updated_at` are the binding timestamps.
 */
export const GroupWorkspace = z.object({
  /** Feishu chat id. */
  chat_id: z.string(),
  /** Stable workspace id. */
  workspace_id: z.string(),
  /** Human-readable workspace name (from workspaces). */
  workspace_name: z.string(),
  /** Absolute path of the workspace root (from workspaces). */
  workspace_path: z.string(),
  /** Basename of the active repo (from workspaces), or null. */
  active_repo: z.string().nullable(),
  /** Git branch the active repo should be on (from workspaces), or null. */
  active_branch: z.string().nullable(),
  /** Epoch ms when the binding was created. */
  created_at: z.number(),
  /** Epoch ms when the binding was last updated. */
  updated_at: z.number(),
});
export interface GroupWorkspace extends z.infer<typeof GroupWorkspace> {}

export const WorkspaceBinding = GroupWorkspace.extend({
  workspace: Workspace.optional(),
});
export interface WorkspaceBinding extends z.infer<typeof WorkspaceBinding> {}
