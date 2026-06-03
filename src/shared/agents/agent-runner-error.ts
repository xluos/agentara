export interface AgentCliExitErrorOptions {
  runner: string;
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export class AgentCliExitError extends Error {
  readonly runner: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;

  constructor(options: AgentCliExitErrorOptions) {
    const parts: string[] = [];
    const stdout = options.stdout ?? "";
    const stderr = options.stderr ?? "";
    if (stdout.trim()) {
      parts.push(`Stdout:\n${clipTail(stdout.trim(), 1200)}`);
    }
    if (stderr.trim()) {
      parts.push(`Stderr:\n${clipTail(stderr.trim(), 3000)}`);
    }
    const detail = parts.length > 0 ? `\n\n${parts.join("\n\n")}` : "";
    super(`${options.runner} exited with code ${options.exitCode}${detail}`);
    this.name = "AgentCliExitError";
    this.runner = options.runner;
    this.exitCode = options.exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/**
 * Keep only the trailing `maxChars` of `text` (errors surface at the end),
 * prefixing a marker noting how much was dropped. Returns `text` unchanged
 * when it already fits.
 */
export function clipTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const dropped = text.length - maxChars;
  return `... [${dropped} chars truncated]\n${text.slice(-maxChars)}`;
}
