import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import dayjs from "dayjs";
import { eq } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import { groupWorkspaces, workspaces } from "@/kernel/sessioning/data";
import { config, createLogger, uuid, type GroupWorkspace, type Workspace } from "@/shared";

const META_FILE_NAME = "AGENTARA.md";

/**
 * Resolution result for a group's dispatch context: the cwd to spawn the
 * runner in plus any env extras (primary repo hint) derived from the active
 * binding. When `chatId` is unbound, callers fall back to the default
 * workspace and empty envExtras.
 */
export interface WorkspaceResolution {
  cwd: string;
  envExtras: Record<string, string>;
  binding: GroupWorkspace | null;
}

/**
 * CRUD + resolution over the `group_workspaces` table. Single-writer; no
 * caching. Callers should treat results as a snapshot for one dispatch.
 */
export class GroupWorkspaceStore {
  private readonly _logger = createLogger("group-workspace-store");
  private readonly _db: DrizzleDB;

  constructor(db: DrizzleDB) {
    this._db = db;
  }

  /**
   * Ensure the default workspace root + `_default` fallback both exist, and
   * migrate any legacy workspace rows whose on-disk path is not yet keyed by
   * their stable id. Idempotent; safe to call on every boot.
   */
  ensureBaseDirs(): void {
    for (const dir of [config.paths.workspaces, config.paths.default_workspace]) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
        this._logger.info(`Created workspace dir: ${dir}`);
      }
    }
    this._normalizeWorkspacePaths();
  }

  /** Fetch the binding for a Feishu chat, or null when none. */
  getBinding(chatId: string): GroupWorkspace | null {
    const row = this._db
      .select()
      .from(groupWorkspaces)
      .innerJoin(workspaces, eq(groupWorkspaces.workspace_id, workspaces.id))
      .where(eq(groupWorkspaces.chat_id, chatId))
      .get();
    return row ? this._mapJoinedBinding(row) : null;
  }

  /** List all bindings, most recently updated first. */
  listBindings(): GroupWorkspace[] {
    return this._db
      .select()
      .from(groupWorkspaces)
      .innerJoin(workspaces, eq(groupWorkspaces.workspace_id, workspaces.id))
      .all()
      .map((row) => this._mapJoinedBinding(row));
  }

  /** Fetch a workspace by stable id. */
  getWorkspace(workspaceId: string): Workspace | null {
    const row = this._db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .get();
    return row ?? null;
  }

  /** List all known workspaces. */
  listWorkspaces(): Workspace[] {
    return this._db.select().from(workspaces).all();
  }

  /**
   * Upsert the binding for a chat. Creates the row if absent; otherwise
   * merges non-undefined fields over the existing row.
   *
   * `workspace_path`/`workspace_name` are only honored when the workspace is
   * being created (no `workspace_id` supplied and no existing binding that
   * points at one); once a workspace exists, its identity is owned by the
   * workspace record. `active_repo`/`active_branch` always go to the
   * workspace, so groups sharing it see the same active state.
   */
  upsertBinding(
    chatId: string,
    patch: {
      active_repo?: string | null;
      active_branch?: string | null;
      workspace_id?: string;
      workspace_name?: string;
      workspace_path?: string;
    },
  ): GroupWorkspace {
    const now = Date.now();
    const existing = this.getBinding(chatId);
    const workspace = this._resolveWorkspace(chatId, existing, patch, now);

    // Active repo/branch live on the workspace — apply any non-undefined
    // patch values there. If the workspace was just created, it carries the
    // caller's active_repo/active_branch directly; for existing workspaces
    // we write through so shared bindings all see the update.
    const wsActiveRepo =
      patch.active_repo === undefined ? workspace.active_repo : patch.active_repo;
    const wsActiveBranch =
      patch.active_branch === undefined
        ? workspace.active_branch
        : patch.active_branch;
    const wsNameChanged =
      patch.workspace_name !== undefined &&
      patch.workspace_name !== workspace.name;
    const wsActiveChanged =
      wsActiveRepo !== workspace.active_repo ||
      wsActiveBranch !== workspace.active_branch;
    if (wsActiveChanged || wsNameChanged) {
      this._db
        .update(workspaces)
        .set({
          name: wsNameChanged ? patch.workspace_name! : workspace.name,
          active_repo: wsActiveRepo,
          active_branch: wsActiveBranch,
          updated_at: now,
        })
        .where(eq(workspaces.id, workspace.id))
        .run();
      if (wsNameChanged) workspace.name = patch.workspace_name!;
      workspace.active_repo = wsActiveRepo;
      workspace.active_branch = wsActiveBranch;
      workspace.updated_at = now;
    }

    if (!existing) {
      this._db
        .insert(groupWorkspaces)
        .values({
          chat_id: chatId,
          workspace_id: workspace.id,
          created_at: now,
          updated_at: now,
        })
        .run();
      this._writeMetaFile(workspace);
      return {
        chat_id: chatId,
        workspace_id: workspace.id,
        workspace_name: workspace.name,
        workspace_path: workspace.path,
        active_repo: wsActiveRepo,
        active_branch: wsActiveBranch,
        created_at: now,
        updated_at: now,
      };
    }

    this._db
      .update(groupWorkspaces)
      .set({
        workspace_id: workspace.id,
        updated_at: now,
      })
      .where(eq(groupWorkspaces.chat_id, chatId))
      .run();
    this._writeMetaFile(workspace);
    return {
      ...existing,
      workspace_id: workspace.id,
      workspace_name: workspace.name,
      workspace_path: workspace.path,
      active_repo: wsActiveRepo,
      active_branch: wsActiveBranch,
      updated_at: now,
    };
  }

  /**
   * Remove the binding for a chat. No-op when absent. The workspace itself
   * is kept — other groups may still be bound to it, and even when none are,
   * we hold onto it so files in the directory aren't forgotten. Re-binding
   * via `/bind <id>` remains possible after an unbind.
   */
  deleteBinding(chatId: string): boolean {
    const existing = this.getBinding(chatId);
    if (!existing) return false;
    this._db
      .delete(groupWorkspaces)
      .where(eq(groupWorkspaces.chat_id, chatId))
      .run();
    const workspace = this.getWorkspace(existing.workspace_id);
    if (workspace) this._writeMetaFile(workspace);
    return true;
  }

  /**
   * Resolve the cwd + envExtras pair a dispatch should use for this chat.
   *
   * - Binding present with active_repo → cwd = workspace_path,
   *   DEV_ASSETS_PRIMARY_REPO/BRANCH in envExtras
   * - Binding present without active_repo → cwd = workspace_path, no env hint
   * - No binding (or no chatId) → cwd = default workspace, no env hint
   *
   * Guarantees cwd exists on disk.
   */
  resolve(chatId: string | null | undefined): WorkspaceResolution {
    if (!chatId) {
      return this._defaultResolution(null);
    }
    const binding = this.getBinding(chatId);
    if (!binding) {
      return this._defaultResolution(null);
    }
    if (!existsSync(binding.workspace_path)) {
      mkdirSync(binding.workspace_path, { recursive: true });
    }
    const envExtras: Record<string, string> = {};
    if (binding.active_repo) {
      envExtras.DEV_ASSETS_PRIMARY_REPO = binding.active_repo;
      if (binding.active_branch) {
        envExtras.DEV_ASSETS_PRIMARY_BRANCH = binding.active_branch;
      }
    }
    return {
      cwd: binding.workspace_path,
      envExtras,
      binding,
    };
  }

  private _defaultResolution(
    binding: GroupWorkspace | null,
  ): WorkspaceResolution {
    if (!existsSync(config.paths.default_workspace)) {
      mkdirSync(config.paths.default_workspace, { recursive: true });
    }
    return {
      cwd: config.paths.default_workspace,
      envExtras: {},
      binding,
    };
  }

  private _resolveWorkspace(
    chatId: string,
    existing: GroupWorkspace | null,
    patch: {
      workspace_id?: string;
      workspace_name?: string;
      workspace_path?: string;
    },
    now: number,
  ): Workspace {
    if (patch.workspace_id) {
      const workspace = this.getWorkspace(patch.workspace_id);
      if (!workspace) {
        throw new Error(`workspace id "${patch.workspace_id}" does not exist`);
      }
      this._ensureWorkspaceDir(workspace.path);
      return workspace;
    }

    if (existing?.workspace_id) {
      const workspace = this.getWorkspace(existing.workspace_id);
      if (!workspace) {
        throw new Error(
          `workspace id "${existing.workspace_id}" referenced by chat "${chatId}" does not exist`,
        );
      }
      this._ensureWorkspaceDir(workspace.path);
      return workspace;
    }

    // Brand-new workspace: directory path is always derived from the stable
    // id so `name` stays a pure display label. `patch.workspace_name` (or
    // `workspace_path`'s basename as a last resort) only seeds the display
    // name; it does not affect the on-disk directory.
    const id = this._newWorkspaceId();
    const workspacePath = config.paths.resolveWorkspacePathById(id);
    const workspaceName =
      patch.workspace_name ??
      (patch.workspace_path ? _safeBasename(patch.workspace_path) : id);
    this._ensureWorkspaceDir(workspacePath);
    const workspace: Workspace = {
      id,
      name: workspaceName,
      path: workspacePath,
      active_repo: null,
      active_branch: null,
      created_at: now,
      updated_at: now,
    };
    this._db.insert(workspaces).values(workspace).run();
    this._writeMetaFile(workspace);
    return workspace;
  }

  private _ensureWorkspaceDir(workspacePath: string): void {
    if (!existsSync(workspacePath)) {
      mkdirSync(workspacePath, { recursive: true });
      this._logger.info(`Created workspace: ${workspacePath}`);
    }
  }

  private _newWorkspaceId(): string {
    return `ws_${uuid().replace(/-/g, "").slice(0, 12)}`;
  }

  private _mapJoinedBinding(row: {
    group_workspaces: typeof groupWorkspaces.$inferSelect;
    workspaces: typeof workspaces.$inferSelect;
  }): GroupWorkspace {
    return {
      chat_id: row.group_workspaces.chat_id,
      workspace_id: row.workspaces.id,
      workspace_name: row.workspaces.name,
      workspace_path: row.workspaces.path,
      active_repo: row.workspaces.active_repo,
      active_branch: row.workspaces.active_branch,
      created_at: row.group_workspaces.created_at,
      updated_at: row.group_workspaces.updated_at,
    };
  }

  /**
   * Boot-time fixup: move legacy workspace directories (named after chat_ids
   * or user-picked slugs) to id-keyed paths. Idempotent; any row whose
   * on-disk path already matches `workspaces/<id>/` is skipped. If a legacy
   * directory exists on disk we `rename` it in place; if it's already gone
   * we just create a fresh empty directory at the new path.
   */
  private _normalizeWorkspacePaths(): void {
    const rows = this._db.select().from(workspaces).all();
    const now = Date.now();
    for (const row of rows) {
      const desired = config.paths.resolveWorkspacePathById(row.id);
      if (row.path === desired && existsSync(desired)) {
        this._writeMetaFile(row);
        continue;
      }
      if (row.path !== desired && existsSync(row.path) && !existsSync(desired)) {
        try {
          renameSync(row.path, desired);
          this._logger.info(
            { from: row.path, to: desired, workspace_id: row.id },
            "normalized workspace path",
          );
        } catch (err) {
          this._logger.error(
            { err, from: row.path, to: desired, workspace_id: row.id },
            "failed to normalize workspace path; leaving as-is",
          );
          continue;
        }
      } else if (!existsSync(desired)) {
        this._ensureWorkspaceDir(desired);
      }
      this._db
        .update(workspaces)
        .set({ path: desired, updated_at: now })
        .where(eq(workspaces.id, row.id))
        .run();
      this._writeMetaFile({ ...row, path: desired, updated_at: now });
    }
  }

  /**
   * Write / overwrite the `AGENTARA.md` info file at the workspace root.
   * This is a human-readable summary of the workspace: stable id, display
   * name, on-disk path, bound chats, and active repo/branch. Safe to
   * regenerate on every mutation; the file is marked as auto-generated.
   */
  private _writeMetaFile(workspace: Workspace): void {
    try {
      const bindings = this._db
        .select({ chat_id: groupWorkspaces.chat_id })
        .from(groupWorkspaces)
        .where(eq(groupWorkspaces.workspace_id, workspace.id))
        .all();
      const chatLines =
        bindings.length === 0
          ? "- _(none — run `/bind` in a chat to attach.)_"
          : bindings.map((b) => `- \`${b.chat_id}\``).join("\n");
      const active = workspace.active_repo
        ? `\`${workspace.active_repo}${
            workspace.active_branch ? " " + workspace.active_branch : ""
          }\``
        : "_(unset)_";
      const lines = [
        `# Workspace: ${workspace.name}`,
        "",
        `- **ID**: \`${workspace.id}\``,
        `- **Path**: \`${workspace.path}\``,
        `- **Active repo**: ${active}`,
        `- **Created**: ${_formatTs(workspace.created_at)}`,
        `- **Updated**: ${_formatTs(workspace.updated_at)}`,
        "",
        "## Bound chats",
        "",
        chatLines,
        "",
        "<!-- Auto-generated by agentara. Edit via `/setup` in a bound chat. -->",
        "",
      ];
      if (!existsSync(workspace.path)) {
        mkdirSync(workspace.path, { recursive: true });
      }
      writeFileSync(join(workspace.path, META_FILE_NAME), lines.join("\n"));
    } catch (err) {
      this._logger.warn(
        { err, workspace_id: workspace.id },
        "failed to write workspace meta file",
      );
    }
  }
}

function _safeBasename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const idx = Math.max(
    trimmed.lastIndexOf("/"),
    trimmed.lastIndexOf("\\"),
  );
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function _formatTs(ms: number): string {
  return dayjs(ms).format("YYYY-MM-DD HH:mm:ss");
}
