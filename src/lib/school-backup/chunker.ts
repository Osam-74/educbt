/**
 * Browser-side upload plan: how to slice a file and how to retry a piece. Pure, so it is unit-tested
 * without a browser. The server NEVER trusts any of this: it re-checks every size, count and the
 * whole-file checksum itself (upload.ts). This only decides what to send.
 */

/** Must stay at or below the server's MAX_CHUNK_BYTES (3 MB, itself under Vercel's 4.5 MB request cap). */
export const PIECE_BYTES = 3 * 1024 * 1024 - 1024;

export type Piece = { position: number; start: number; end: number };

export function planPieces(totalBytes: number, pieceBytes: number = PIECE_BYTES): Piece[] {
  if (!Number.isInteger(totalBytes) || totalBytes <= 0) throw new Error('The file is empty.');
  if (!Number.isInteger(pieceBytes) || pieceBytes <= 0) throw new Error('Bad piece size.');
  const pieces: Piece[] = [];
  for (let start = 0, position = 0; start < totalBytes; start += pieceBytes, position++) {
    pieces.push({ position, start, end: Math.min(start + pieceBytes, totalBytes) });
  }
  return pieces;
}

/** Wait before retry number `attempt` (1-based): 1s, 2s, 4s, 8s... capped, with a little jitter. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(1000 * 2 ** (attempt - 1), 15_000);
  return Math.round(base * (0.75 + random() * 0.5));
}

/** Network failures and server hiccups are worth retrying; a refusal that will never succeed is not. */
export function isRetryable(status: number | null): boolean {
  if (status === null) return true;            // the request never completed (offline, dropped)
  if (status === 408 || status === 429) return true;
  return status >= 500;                        // 4xx (bad piece, not signed in, wrong origin) will not fix itself
}

export const MAX_ATTEMPTS = 6;

/** Whole-file progress as a whole percentage that never reaches 100 until the server confirms the finish. */
export function percent(sentPieces: number, totalPieces: number, finished: boolean): number {
  if (finished) return 100;
  if (totalPieces <= 0) return 0;
  return Math.min(99, Math.floor((sentPieces / totalPieces) * 100));
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
