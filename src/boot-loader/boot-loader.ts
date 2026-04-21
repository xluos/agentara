import { execSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { config, createLogger, reloadConfig } from "@/shared";

const logger = createLogger("boot-loader");

/**
 * The BootLoader is the main entry point for the agentara application
 */
class BootLoader {
  /**
   * Bootstraps the application by verifying the integrity and then igniting the kernel.
   */
  public async bootstrap(): Promise<void> {
    await this._verifyIntegrity();
    await this._igniteKernel();
  }

  private async _verifyIntegrity(): Promise<void> {
    if (!existsSync(config.paths.home)) {
      mkdirSync(config.paths.home, { recursive: true });
    }
    if (!existsSync(config.paths.workspace)) {
      mkdirSync(config.paths.workspace, { recursive: true });
    }
    if (!existsSync(config.paths.sessions)) {
      mkdirSync(config.paths.sessions, { recursive: true });
    }
    if (!existsSync(config.paths.data)) {
      mkdirSync(config.paths.data, { recursive: true });
    }
    if (!existsSync(config.paths.uploads)) {
      mkdirSync(config.paths.uploads, { recursive: true });
    }
    if (!existsSync(config.paths.outputs)) {
      mkdirSync(config.paths.outputs, { recursive: true });
    }
    if (!existsSync(config.paths.workspaces)) {
      mkdirSync(config.paths.workspaces, { recursive: true });
    }
    if (!existsSync(config.paths.default_workspace)) {
      mkdirSync(config.paths.default_workspace, { recursive: true });
    }

    if (!existsSync(config.paths.memory)) {
      mkdirSync(config.paths.memory, { recursive: true });
    }
    if (!existsSync(config.paths.claude_home)) {
      mkdirSync(config.paths.claude_home, { recursive: true });
    }
    if (!existsSync(join(config.paths.claude_home, "settings.json"))) {
      await downloadFile(
        "https://raw.githubusercontent.com/magiccube/agentara/main/user-home/.claude/settings.json",
        join(config.paths.claude_home, "settings.json"),
      );
    }
    const claudeMdPath = join(config.paths.home, "CLAUDE.md");
    if (!existsSync(claudeMdPath)) {
      await downloadFile(
        "https://raw.githubusercontent.com/magiccube/agentara/main/user-home/CLAUDE.md",
        claudeMdPath,
      );
    }
    if (!existsSync(config.paths.repos_md)) {
      writeFileSync(config.paths.repos_md, REPOS_MD_TEMPLATE, "utf-8");
      logger.info("Seeded $AGENTARA_HOME/REPOS.md with a starter template.");
    }
    // Keep CLAUDE.md pointed at REPOS.md so the agent sees the catalog +
    // descriptions in context. Idempotent: only appends when the reference
    // is missing, so user edits to CLAUDE.md are preserved.
    this._ensureClaudeMdReferencesRepos(claudeMdPath);
    if (!existsSync(config.paths.skills)) {
      await downloadSkills();
    }

    // Symlink .agents/skills → .claude/skills so the Codex CLI can also
    // read skills.  Only created once; subsequent boots see the existing link.
    this._ensureSkillsSymlink();

    const configPath = join(config.paths.home, "config.yaml");
    if (!existsSync(configPath)) {
      logger.info("config.yaml not found, generating default configuration...");
      const defaultTimezone =
        Intl.DateTimeFormat().resolvedOptions().timeZone;
      const defaultConfig = `timezone: "${defaultTimezone}"

agents:
  default:
    type: claude
    # model: claude-sonnet-4-6   # optional; omit to use the CLI's default
  codex:
    isolate_host_env: false

tasking:
  max_retries: 1

messaging:
  default_channel_id: ""
  channels: []
`;
      writeFileSync(configPath, defaultConfig, "utf-8");
    }

    reloadConfig();

    if (!existsSync(config.paths.data)) {
      mkdirSync(config.paths.data, { recursive: true });
    }

    // Codex isolation (opt-in via `agents.codex.isolate_host_env`).
    // When off, agentara-spawned Codex inherits the host `~/.codex`
    // verbatim.  When on, agentara points Codex at its own
    // CODEX_HOME so config / sessions / state / skills stay
    // separate from the host's; auth.json is symlinked so the
    // OAuth login is shared.  Nothing agentara does can prevent
    // Codex from loading hooks from cwd ancestors under the real
    // home — that problem lives in the host `~/.codex/hooks.json`
    // placement itself.
    if (config.agents.codex.isolate_host_env) {
      if (!existsSync(config.paths.codex_home)) {
        mkdirSync(config.paths.codex_home, { recursive: true });
      }
      this._ensureCodexAuthSymlink();
    }
  }

  /**
   * Append `@REPOS.md` to `$AGENTARA_HOME/CLAUDE.md` if it isn't already
   * referenced. The reference lets Claude Code inline the repo catalog +
   * descriptions into the agent's context via its native `@file` import.
   * User edits to CLAUDE.md are preserved — we only append when missing.
   */
  private _ensureClaudeMdReferencesRepos(claudeMdPath: string): void {
    try {
      if (!existsSync(claudeMdPath)) return;
      const body = readFileSync(claudeMdPath, "utf-8");
      if (/^\s*@REPOS\.md\s*$/m.test(body)) return;
      const needsNewline = body.length > 0 && !body.endsWith("\n");
      appendFileSync(
        claudeMdPath,
        `${needsNewline ? "\n" : ""}\n@REPOS.md\n`,
        "utf-8",
      );
      logger.info("Added `@REPOS.md` reference to CLAUDE.md.");
    } catch (err) {
      logger.warn({ err }, "Failed to ensure CLAUDE.md references REPOS.md");
    }
  }

  /**
   * Creates a symlink at `.agents/skills` → `.claude/skills` so the Codex
   * CLI can discover skills via its native directory.  The link is only
   * created once; if it already exists no action is taken.
   */
  private _ensureSkillsSymlink(): void {
    const linkPath = join(config.paths.agents_home, "skills");
    try {
      try {
        lstatSync(linkPath);
        return;
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
          throw e;
        }
        // Path truly does not exist; fall through to create it.
      }
      mkdirSync(config.paths.agents_home, { recursive: true });
      symlinkSync(config.paths.skills, linkPath, "dir");
      logger.info("Created symlink .agents/skills → .claude/skills");
    } catch (err) {
      logger.warn({ err }, "Failed to create .agents/skills symlink");
    }
  }

  /**
   * Symlinks `$CODEX_HOME/auth.json` → `~/.codex/auth.json` so the
   * isolated Codex home reuses the host login and OAuth token
   * refresh stays bi-directional.  No-ops if the link already exists
   * or the host has no auth file yet.
   */
  private _ensureCodexAuthSymlink(): void {
    const hostAuth = join(config.paths.host_codex_home, "auth.json");
    const linkPath = join(config.paths.codex_home, "auth.json");
    try {
      lstatSync(linkPath);
      return;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
        logger.warn({ err: e }, "Unexpected error checking Codex auth link");
        return;
      }
    }
    if (!existsSync(hostAuth)) {
      logger.info(
        "Host ~/.codex/auth.json not found — skipping Codex auth symlink",
      );
      return;
    }
    try {
      symlinkSync(hostAuth, linkPath, "file");
      logger.info(
        "Created symlink $AGENTARA_HOME/.codex/auth.json → ~/.codex/auth.json",
      );
    } catch (err) {
      logger.warn({ err }, "Failed to create Codex auth symlink");
    }
  }

  private async _igniteKernel(): Promise<void> {
    const { kernel } = await import("@/kernel");
    const logo = `\n▗▄▖  ▗▄▄▖▗▄▄▄▖▗▖  ▗▖▗▄▄▄▖▗▄▖ ▗▄▄▖  ▗▄▖
▐▌ ▐▌▐▌   ▐▌   ▐▛▚▖▐▌  █ ▐▌ ▐▌▐▌ ▐▌▐▌ ▐▌
▐▛▀▜▌▐▌▝▜▌▐▛▀▀▘▐▌ ▝▜▌  █ ▐▛▀▜▌▐▛▀▚▖▐▛▀▜▌
▐▌ ▐▌▝▚▄▞▘▐▙▄▄▖▐▌  ▐▌  █ ▐▌ ▐▌▐▌ ▐▌▐▌ ▐▌`;
    console.info(
      "\x1b[31m" +
        logo +
        "\x1b[0m" +
        "\n\nCopyright (c) 2026 Agentara. All rights reserved.\nVisit https://github.com/agentara/agentara for more information.\n\n",
    );
    await kernel.start();
    logger.info("🚀 Agentara is now running...");
  }
}

async function downloadFile(url: string, path: string): Promise<void> {
  const response = await fetch(url);
  const data = await response.arrayBuffer();
  writeFileSync(path, Buffer.from(data));
}

async function downloadSkills(): Promise<void> {
  mkdirSync(config.paths.skills, { recursive: true });
  const tempDir = mkdtempSync("agentara-github-repo-");
  execSync(
    `git clone --depth 1 --filter=blob:none --sparse https://github.com/magiccube/agentara.git ${tempDir}`,
  );
  execSync(`cd ${tempDir} && git sparse-checkout set user-home/.claude/skills`);
  execSync(`cp -r user-home/.claude/skills/* ~/.agentara/.claude/skills/`);
  execSync(`rm -rf ${tempDir}`);
}

const REPOS_MD_TEMPLATE = `# Predefined Repos

<!--
This file is the agent's repo knowledge base.

- The \`/setup\` command parses each H2 section as a repo:
    - title (\`## <name>\`)                → repo directory name
    - \`- git_url: <url>\` bullet          → clone URL
    - \`- description: <one-liner>\` bullet → short tagline shown on the card
- Keep \`description\` to one short sentence — the card only needs a
  quick label, not the full context.
- Everything else in a section is free-form prose for the agent to read
  via CLAUDE.md's \`@REPOS.md\` import. Feel free to update it as you
  learn more about each repo.
-->

<!-- Example — delete or replace with your own entries:

## agentara

- git_url: https://github.com/magiccube/agentara.git
- description: Bun + TypeScript personal assistant platform.

Core flow is BootLoader → Kernel → Session/Task/Message. Useful when
a group is discussing the assistant platform itself, session/task
orchestration, or Feishu bot integration.

-->
`;

export const bootLoader = new BootLoader();
