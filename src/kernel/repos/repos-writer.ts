import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { config } from "@/shared";

/**
 * Boundary of a single `## <name>` section in `REPOS.md`. `start` is the
 * 0-based line index of the heading itself; `end` is the line index AFTER
 * the section (i.e. the next H2 line or `lines.length`). Sections nested
 * inside `<!-- ... -->` blocks are skipped by `findSection` — only real
 * repo entries are mutated.
 */
interface SectionRange {
  start: number;
  end: number;
}

/**
 * Inputs for `addRepo` / `editRepo`. `description` is optional — REPOS.md
 * allows missing description bullets.
 */
export interface RepoInput {
  name: string;
  git_url: string;
  description?: string;
}

export interface WriteResult {
  ok: boolean;
  reason?: string;
}

/**
 * Append a new repo section to `REPOS.md`. Fails fast when a section with
 * the same name already exists so the user has to delete it first instead
 * of silently overwriting context they accumulated under the existing
 * heading.
 */
export function addRepo(input: RepoInput): WriteResult {
  const raw = _readFile();
  if (_findSection(raw, input.name)) {
    return { ok: false, reason: `仓库 \`${input.name}\` 已存在，请先编辑或删除。` };
  }
  const trimmed = raw.replace(/\s+$/, "");
  const block = _formatSection(input);
  const next = trimmed.length > 0 ? `${trimmed}\n\n${block}\n` : `${block}\n`;
  writeFileSync(config.paths.repos_md, next, "utf-8");
  return { ok: true };
}

/**
 * Update the `git_url` and/or `description` bullets of an existing section.
 * Non-bullet content (free-form agent context) inside the section is
 * preserved verbatim — only the two structured bullet lines are touched.
 * Returns `{ ok: false }` when the section doesn't exist.
 */
export function editRepo(
  name: string,
  patch: { git_url?: string; description?: string },
): WriteResult {
  const raw = _readFile();
  const range = _findSection(raw, name);
  if (!range) {
    return { ok: false, reason: `仓库 \`${name}\` 不存在。` };
  }
  const lines = raw.split(/\r?\n/);
  const section = lines.slice(range.start, range.end);
  let gitTouched = false;
  let descTouched = false;
  for (let i = 0; i < section.length; i += 1) {
    const line = section[i]!;
    if (patch.git_url !== undefined && /^\s*-\s*git_url\s*:/.test(line)) {
      section[i] = `- git_url: ${patch.git_url}`;
      gitTouched = true;
    }
    if (patch.description !== undefined && /^\s*-\s*description\s*:/.test(line)) {
      section[i] = `- description: ${patch.description}`;
      descTouched = true;
    }
  }
  // Bullets that didn't exist before get appended right after the heading
  // so they land at the canonical spot for the next read.
  const headerIdx = 0;
  const insertions: string[] = [];
  if (patch.git_url !== undefined && !gitTouched) {
    insertions.push(`- git_url: ${patch.git_url}`);
  }
  if (patch.description !== undefined && !descTouched) {
    insertions.push(`- description: ${patch.description}`);
  }
  if (insertions.length > 0) {
    section.splice(headerIdx + 1, 0, "", ...insertions);
  }
  const next = [
    ...lines.slice(0, range.start),
    ...section,
    ...lines.slice(range.end),
  ].join("\n");
  writeFileSync(config.paths.repos_md, next, "utf-8");
  return { ok: true };
}

/**
 * Remove a section in its entirety. Trailing whitespace between adjacent
 * sections is collapsed so the file stays tidy across repeated edits.
 */
export function removeRepo(name: string): WriteResult {
  const raw = _readFile();
  const range = _findSection(raw, name);
  if (!range) {
    return { ok: false, reason: `仓库 \`${name}\` 不存在。` };
  }
  const lines = raw.split(/\r?\n/);
  const next = [
    ...lines.slice(0, range.start),
    ...lines.slice(range.end),
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
  writeFileSync(config.paths.repos_md, next, "utf-8");
  return { ok: true };
}

function _readFile(): string {
  if (!existsSync(config.paths.repos_md)) return "";
  return readFileSync(config.paths.repos_md, "utf-8");
}

function _formatSection(repo: RepoInput): string {
  const desc = repo.description?.trim();
  const bullets = [`- git_url: ${repo.git_url}`];
  if (desc) bullets.push(`- description: ${desc}`);
  return [`## ${repo.name}`, "", ...bullets].join("\n");
}

/**
 * Locate a section by name while ignoring H2 headings that live inside
 * `<!-- ... -->` comment blocks. Mirrors the comment-skipping logic in
 * `loadPredefinedRepos` so writer and reader stay in lockstep.
 */
function _findSection(raw: string, name: string): SectionRange | null {
  const lines = raw.split(/\r?\n/);
  const target = name.trim();
  let inHtmlComment = false;
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (inHtmlComment) {
      if (line.includes("-->")) inHtmlComment = false;
      continue;
    }
    if (line.trim().startsWith("<!--") && !line.includes("-->")) {
      inHtmlComment = true;
      continue;
    }
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (!h2) continue;
    if (start === -1) {
      if (h2[1]!.trim() === target) start = i;
      continue;
    }
    // Second H2 (after we've found ours) terminates the section.
    return { start, end: i };
  }
  if (start === -1) return null;
  return { start, end: lines.length };
}
