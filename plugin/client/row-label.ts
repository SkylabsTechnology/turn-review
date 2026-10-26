/**
 * Pure row-display helpers for the tracker file list. Extracted from the React
 * component so the exact rules the user asked for (fileName/filePath split,
 * grey-when-zero counters) are unit-testable without a renderer.
 */

/** Split a repo-relative POSIX path into the file name and its directory part. */
export function rowLabel(path: string): { fileName: string; dirPath: string } {
  const slash = path.lastIndexOf('/');
  return {
    fileName: slash >= 0 ? path.slice(slash + 1) : path,
    dirPath: slash >= 0 ? path.slice(0, slash + 1) : '',
  };
}

/**
 * Counter color: use `positive` when the count is > 0, `muted` when it is 0
 * (the user's "if it is 0 make this grey" rule).
 */
export function countColor(count: number, positive: string, muted: string): string {
  return count > 0 ? positive : muted;
}
