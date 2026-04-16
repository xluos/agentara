import { existsSync, mkdirSync } from "node:fs";

import { eq } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import { groupWorkspaces } from "@/kernel/sessioning/data";
import { config, createLogger, type GroupWorkspace } from "@/shared";

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
   * Ensure the default workspace root + `_default` fallback both exist.
   * Idempotent; safe to call on every boot.
   */
  ensureBaseDirs(): void {
    for (const dir of [config.paths.workspaces, config.paths.default_workspace]) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
        this._logger.info(`Created workspace dir: ${dir}`);
      }
    }
  }

  /** Fetch the binding for a Feishu chat, or null when none. */
  getBinding(chatId: string): GroupWorkspace | null {
    const row = this._db
      .select()
      .from(groupWorkspaces)
      .where(eq(groupWorkspaces.chat_id, chatId))
      .get();
    return row ?? null;
  }

  /** List all bindings, most recently updated first. */
  listBindings(): GroupWorkspace[] {
    return this._db.select().from(groupWorkspaces).all();
  }

  /**
   * Upsert the binding for a chat. Creates the row if absent; otherwise
   * merges non-undefined fields over the existing row. Ensures the
   * workspace directory exists on disk.
   */
  upsertBinding(
    chatId: string,
    patch: { active_repo?: string | null; active_branch?: string | null },
  ): GroupWorkspace {
    const workspacePath = config.paths.resolveGroupWorkspacePath(chatId);
    if (!existsSync(workspacePath)) {
      mkdirSync(workspacePath, { recursive: true });
      this._logger.info(`Created group workspace: ${workspacePath}`);
    }

    const now = Date.now();
    const existing = this.getBinding(chatId);
    if (!existing) {
      const row: GroupWorkspace = {
        chat_id: chatId,
        workspace_path: workspacePath,
        active_repo: patch.active_repo ?? null,
        active_branch: patch.active_branch ?? null,
        created_at: now,
        updated_at: now,
      };
      this._db.insert(groupWorkspaces).values(row).run();
      return row;
    }

    const merged: GroupWorkspace = {
      ...existing,
      workspace_path: workspacePath,
      active_repo:
        patch.active_repo === undefined ? existing.active_repo : patch.active_repo,
      active_branch:
        patch.active_branch === undefined
          ? existing.active_branch
          : patch.active_branch,
      updated_at: now,
    };
    this._db
      .update(groupWorkspaces)
      .set({
        workspace_path: merged.workspace_path,
        active_repo: merged.active_repo,
        active_branch: merged.active_branch,
        updated_at: merged.updated_at,
      })
      .where(eq(groupWorkspaces.chat_id, chatId))
      .run();
    return merged;
  }

  /** Remove the binding for a chat. No-op when absent. */
  deleteBinding(chatId: string): boolean {
    const existing = this.getBinding(chatId);
    if (!existing) return false;
    this._db
      .delete(groupWorkspaces)
      .where(eq(groupWorkspaces.chat_id, chatId))
      .run();
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
}
