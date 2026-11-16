// Bounds for agent file mutations and their undo snapshots. A single large
// file used to be read three or four times (snapshot, edit source, rebuilt
// text, JSON-encoded snapshot), which can exhaust the 512MB main-process heap
// and freeze the UI in JSON.stringify. 2 MiB is generous for source files and
// keeps the worst-case JSON snapshot well below that budget.
export const MAX_MUTATION_BYTES = 2 * 1024 * 1024

/** A 2 MiB string can expand up to 6x when JSON-escaped (\uXXXX). */
export const MAX_SNAPSHOT_JSON_BYTES = MAX_MUTATION_BYTES * 6 + 1024

/** Total on-disk snapshot budget, independent of the 100-file count cap. */
export const MAX_SNAPSHOT_TOTAL_BYTES = 50 * 1024 * 1024

export function mutationTooLargeError(filePath: string, bytes: number): Error {
  const mib = Math.max(0, bytes) / 1024 / 1024
  return new Error(
    `File mutation refused: ${filePath} is ${mib.toFixed(1)} MiB; limit ${MAX_MUTATION_BYTES / 1024 / 1024} MiB so undo snapshots stay bounded. No file was changed. Ask the user to reduce the file or edit it externally; do not retry the same write/edit.`
  )
}
