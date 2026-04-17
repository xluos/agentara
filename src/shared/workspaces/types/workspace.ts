import { z } from "zod";

/**
 * A reusable workspace entity with a stable id.
 *
 * The `name` remains human-readable for operators, while `id` is what other
 * groups can use to bind to the exact same workspace directory later.
 *
 * `active_repo`/`active_branch` live on the workspace (not the binding)
 * because only one `.git/HEAD` exists per cloned repo — the "active"
 * state is a property of the directory on disk, shared across all groups
 * bound to the workspace.
 */
export const Workspace = z.object({
  /** Stable workspace id. */
  id: z.string(),
  /** Human-readable workspace name. */
  name: z.string(),
  /** Absolute path of the workspace root. */
  path: z.string(),
  /** Basename of the currently focused repo under `path`, or null. */
  active_repo: z.string().nullable(),
  /** Git branch to check out in the active repo on dispatch, or null. */
  active_branch: z.string().nullable(),
  /** Epoch ms when the workspace was created. */
  created_at: z.number(),
  /** Epoch ms when the workspace was last updated. */
  updated_at: z.number(),
});
export interface Workspace extends z.infer<typeof Workspace> {}
