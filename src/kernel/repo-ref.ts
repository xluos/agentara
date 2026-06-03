/**
 * User-facing repo/branch label used across workspace cards and command
 * results. Keep the separator centralized so copy stays consistent.
 */
export function formatRepoRef(
  repo: string,
  branch?: string | null,
): string {
  return branch ? `${repo}@${branch}` : repo;
}
