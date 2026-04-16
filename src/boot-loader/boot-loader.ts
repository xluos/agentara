import { execSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
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
    if (!existsSync(join(config.paths.home, "CLAUDE.md"))) {
      await downloadFile(
        "https://raw.githubusercontent.com/magiccube/agentara/main/user-home/CLAUDE.md",
        join(config.paths.home, "CLAUDE.md"),
      );
    }
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
    model: claude-sonnet-4-6

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

export const bootLoader = new BootLoader();
