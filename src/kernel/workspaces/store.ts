import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, sep } from "node:path";

import dayjs from "dayjs";
import { eq, inArray, like, or } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import { groupWorkspaces, sessions, workspaces } from "@/kernel/sessioning/data";
import { tasks } from "@/kernel/tasking/data";
import { config, createLogger, uuid, type GroupWorkspace, type Workspace } from "@/shared";

import { readRepoHead } from "./git-sync";

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
      this.touchLastActive(workspace.id, now);
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
    this.touchLastActive(workspace.id, now);
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
    this.touchLastActive(binding.workspace_id);
    const envExtras: Record<string, string> = {};
    if (binding.active_repo) {
      envExtras.DEV_ASSETS_PRIMARY_REPO = binding.active_repo;
      // Informational env — reflect the repo's actual HEAD, not the stored
      // `active_branch` hint, so the agent sees what it will actually run on.
      const head = readRepoHead(join(binding.workspace_path, binding.active_repo));
      if (head) {
        envExtras.DEV_ASSETS_PRIMARY_BRANCH = head;
      }
    }
    return {
      cwd: binding.workspace_path,
      envExtras,
      binding,
    };
  }

  /**
   * Bump `workspaces.last_active_at` for the given workspace. Cheap update —
   * leaves `updated_at` alone so the two columns stay semantically distinct
   * (`updated_at` = row mutated, `last_active_at` = workspace was used).
   */
  touchLastActive(workspaceId: string, ts: number = Date.now()): void {
    this._db
      .update(workspaces)
      .set({ last_active_at: ts })
      .where(eq(workspaces.id, workspaceId))
      .run();
  }

  /**
   * Fully remove a workspace: tasks → sessions → bindings → row → on-disk
   * directory. The shared git-cache at `$AGENTARA_HOME/git-cache/` is left
   * intact so other workspaces keep benefiting from it. Refuses to touch
   * the reserved `_default` fallback directory.
   */
  deleteWorkspace(workspaceId: string): WorkspaceDeleteResult {
    const workspace = this.getWorkspace(workspaceId);
    if (!workspace) {
      throw new WorkspaceNotFoundError(workspaceId);
    }
    if (workspace.path === config.paths.default_workspace) {
      throw new WorkspaceProtectedError(workspaceId);
    }

    const sessionRows = this._db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        or(
          eq(sessions.cwd, workspace.path),
          like(sessions.cwd, `${workspace.path}/%`),
        ),
      )
      .all();
    const sessionIds = sessionRows.map((r) => r.id);

    let removedTasks = 0;
    if (sessionIds.length > 0) {
      const taskRows = this._db
        .select({ id: tasks.id })
        .from(tasks)
        .where(inArray(tasks.session_id, sessionIds))
        .all();
      removedTasks = taskRows.length;
      if (removedTasks > 0) {
        this._db.delete(tasks).where(inArray(tasks.session_id, sessionIds)).run();
      }
      this._db.delete(sessions).where(inArray(sessions.id, sessionIds)).run();
    }

    const bindingRows = this._db
      .select({ chat_id: groupWorkspaces.chat_id })
      .from(groupWorkspaces)
      .where(eq(groupWorkspaces.workspace_id, workspaceId))
      .all();
    this._db
      .delete(groupWorkspaces)
      .where(eq(groupWorkspaces.workspace_id, workspaceId))
      .run();
    this._db.delete(workspaces).where(eq(workspaces.id, workspaceId)).run();

    let removedDirectory = false;
    try {
      if (existsSync(workspace.path)) {
        rmSync(workspace.path, { recursive: true, force: true });
        removedDirectory = true;
      }
    } catch (err) {
      this._logger.error(
        { err, workspace_id: workspaceId, path: workspace.path },
        "failed to remove workspace directory; db rows already gone",
      );
    }

    const result: WorkspaceDeleteResult = {
      workspace_id: workspaceId,
      workspace_name: workspace.name,
      workspace_path: workspace.path,
      removed_bindings: bindingRows.length,
      removed_sessions: sessionIds.length,
      removed_tasks: removedTasks,
      removed_directory: removedDirectory,
    };
    this._logger.info(result, "workspace deleted");
    return result;
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
      last_active_at: now,
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
    this._linkGlobalAssets(workspacePath);
  }

  /**
   * Symlink the shared instruction + memory surface from agentara home into
   * every workspace root. Without this, Codex (whose `@import` resolver uses
   * cwd as baseDir, and whose own auto-memory writes under `<cwd>/memory/`)
   * ends up with a stale `<!-- file not found -->` AGENTS.md at the home
   * level and a per-workspace memory island that never reaches the global
   * SOUL/USER context. Symlinking is chosen over copying so writes on either
   * side are seen by the other.
   *
   * Only `.claude/skills/` is shared from `.claude/` — the rest (runtime
   * state, local settings, todos) stays per-workspace to avoid cross-session
   * contention.
   */
  private _linkGlobalAssets(workspacePath: string): void {
    // Never clobber agentara home itself; an in-home "workspace" would
    // recurse onto its own files.
    if (workspacePath === config.paths.home) return;
    // Only manage workspaces under the managed workspaces root. If a user
    // points at an arbitrary path, leave it alone.
    if (!workspacePath.startsWith(config.paths.workspaces + sep)) return;

    const linkSpecs: Array<{ src: string; dst: string }> = [
      { src: join(config.paths.home, "CLAUDE.md"), dst: join(workspacePath, "CLAUDE.md") },
      { src: config.paths.repos_md, dst: join(workspacePath, "REPOS.md") },
      { src: config.paths.memory, dst: join(workspacePath, "memory") },
      {
        src: config.paths.skills,
        dst: join(workspacePath, ".claude", "skills"),
      },
    ];

    for (const { src, dst } of linkSpecs) {
      if (!existsSync(src)) continue;
      const parent = join(dst, "..");
      if (!existsSync(parent)) {
        try {
          mkdirSync(parent, { recursive: true });
        } catch (err) {
          this._logger.warn({ err, parent }, "failed to create parent dir for symlink");
          continue;
        }
      }
      this._ensureSymlink(src, dst);
    }
  }

  /**
   * Idempotently ensure `dst` is a symlink pointing at `src`. If `dst` is
   * already a symlink to the same target, no-op. If it's a symlink to a
   * different target, replace it. If it's a real file or directory, move it
   * aside to `<dst>.bak.<timestamp>` before creating the link, so we never
   * silently destroy existing content.
   */
  private _ensureSymlink(src: string, dst: string): void {
    try {
      const st = lstatSync(dst, { throwIfNoEntry: false });
      if (st) {
        if (st.isSymbolicLink()) {
          if (readlinkSync(dst) === src) return;
          rmSync(dst);
        } else {
          const backup = `${dst}.bak.${Date.now()}`;
          renameSync(dst, backup);
          this._logger.info(
            { dst, backup },
            "backed up existing workspace asset before linking",
          );
        }
      }
      symlinkSync(src, dst);
      this._logger.info({ src, dst }, "linked global asset into workspace");
    } catch (err) {
      this._logger.warn({ err, src, dst }, "failed to link global asset");
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
        this._linkGlobalAssets(desired);
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

/**
 * Breakdown of what {@link GroupWorkspaceStore.deleteWorkspace} actually
 * removed. The card uses these counts in the result summary so users see
 * exactly how much state went away.
 */
export interface WorkspaceDeleteResult {
  workspace_id: string;
  workspace_name: string;
  workspace_path: string;
  removed_bindings: number;
  removed_sessions: number;
  removed_tasks: number;
  removed_directory: boolean;
}

/** Thrown when the caller asks to delete a workspace id that doesn't exist. */
export class WorkspaceNotFoundError extends Error {
  constructor(readonly workspace_id: string) {
    super(`workspace id "${workspace_id}" does not exist`);
    this.name = "WorkspaceNotFoundError";
  }
}

/** Thrown when the caller asks to delete the reserved default workspace. */
export class WorkspaceProtectedError extends Error {
  constructor(readonly workspace_id: string) {
    super(
      `workspace "${workspace_id}" is protected (default fallback) and cannot be deleted`,
    );
    this.name = "WorkspaceProtectedError";
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
