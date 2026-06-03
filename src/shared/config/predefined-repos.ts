import { existsSync, readFileSync } from "node:fs";

import { z } from "zod";

import * as paths from "./paths";

/**
 * A predefined repository surfaced by the `/setup` command. The catalog is
 * maintained as Markdown in `$AGENTARA_HOME/REPOS.md` rather than YAML so
 * the same file can double as free-form context that agents read via
 * CLAUDE.md's `@REPOS.md` import — and update in place as they learn more
 * about each repo.
 *
 * `description` is a short one-liner shown on the `/setup` card next to
 * the repo name. Prefer an explicit `- description: <one-liner>` bullet
 * in the section so the card copy stays short; if absent we fall back to
 * the first prose line for backward compatibility. The rest of the section
 * body is free-form agent context, not used by the card renderer.
 */
export const PredefinedRepo = z.object({
  name: z.string(),
  description: z.string().default(""),
  git_url: z.string(),
});
export interface PredefinedRepo extends z.infer<typeof PredefinedRepo> {}

/**
 * Read and parse `$AGENTARA_HOME/REPOS.md`. Returns an empty list when the
 * file does not exist or contains no valid repo sections. Called on demand
 * by `/setup` (not cached) so operators can edit the file and see the
 * change reflected on the next command without restarting the kernel.
 */
export function loadPredefinedRepos(): PredefinedRepo[] {
  if (!existsSync(paths.repos_md)) return [];
  const raw = readFileSync(paths.repos_md, "utf-8");
  return _parseReposMarkdown(raw);
}

interface _PartialRepo {
  name: string;
  git_url?: string;
  description?: string;
}

/**
 * Parse a `REPOS.md`-style document. Each `## <name>` begins a repo;
 * the first `- git_url: <url>` bullet fills `git_url`; a
 * `- description: <one-liner>` bullet, if present, fills `description`.
 * If that bullet is missing, we fall back to the first non-bullet,
 * non-heading, non-comment prose line so older files still render.
 */
function _parseReposMarkdown(markdown: string): PredefinedRepo[] {
  const lines = markdown.split(/\r?\n/);
  const out: PredefinedRepo[] = [];
  let current: _PartialRepo | null = null;
  let proseFallbackCaptured = false;
  let hasExplicitDescription = false;
  let inHtmlComment = false;

  const flush = () => {
    if (current && current.name && current.git_url) {
      const parsed = PredefinedRepo.safeParse({
        name: current.name,
        git_url: current.git_url,
        description: current.description ?? "",
      });
      if (parsed.success) out.push(parsed.data);
    }
  };

  for (const line of lines) {
    if (inHtmlComment) {
      if (line.includes("-->")) inHtmlComment = false;
      continue;
    }
    if (line.trim().startsWith("<!--") && !line.includes("-->")) {
      inHtmlComment = true;
      continue;
    }

    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h2) {
      flush();
      current = { name: h2[1]!.trim() };
      proseFallbackCaptured = false;
      hasExplicitDescription = false;
      continue;
    }
    if (!current) continue;

    const gitUrl = /^\s*-\s*git_url\s*:\s*(\S.*?)\s*$/.exec(line);
    if (gitUrl) {
      current.git_url = gitUrl[1];
      continue;
    }

    const desc = /^\s*-\s*description\s*:\s*(\S.*?)\s*$/.exec(line);
    if (desc) {
      current.description = desc[1];
      hasExplicitDescription = true;
      continue;
    }

    if (!hasExplicitDescription && !proseFallbackCaptured) {
      const trimmed = line.trim();
      if (
        trimmed &&
        !trimmed.startsWith("-") &&
        !trimmed.startsWith("#") &&
        !trimmed.startsWith("<!--") &&
        !trimmed.startsWith(">")
      ) {
        current.description = trimmed;
        proseFallbackCaptured = true;
      }
    }
  }
  flush();

  return out;
}
