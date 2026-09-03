/**
 * pg_dump / pg_restore command construction.
 *
 * Two rules, both load-bearing:
 *  1. NO secret ever appears in argv. Connection is passed as separate
 *     --host/--port/--username/--dbname flags and the password/sslmode go
 *     through PGPASSWORD/PGSSLMODE in the process environment (see
 *     pgToolEnv). `ps` listings and shell error echoes therefore cannot
 *     leak credentials.
 *  2. The same functions build the commands for backup, restore and the
 *     tests, so what the tests prove about argument hygiene is what runs.
 */

import { spawn } from 'node:child_process';
import type { ParsedPgUri } from './pg-uri';
import { pgToolEnv } from './pg-uri';

/**
 * pg_dump in PostgreSQL custom format (-Fc):
 *  - compressed single file — the sane unit for object storage;
 *  - restorable with pg_restore, which supports selective restore,
 *    parallel restore, and --list inspection without touching a database;
 *  - the archive is the format pg_restore can integrity-check cheaply.
 * Chosen over plain SQL (-Fp) because plain dumps are larger, cannot be
 * listed/verified selectively, and restore is whole-file only.
 */
export function pgDumpArgs(uri: ParsedPgUri, outFile: string): string[] {
  return [
    '--format=custom',
    '--file', outFile,
    '--no-password',
    '--host', uri.host,
    '--port', String(uri.port),
    '--username', uri.user,
    uri.dbname,
  ];
}

/** pg_restore into a target database. No --clean: the target must be EMPTY. */
export function pgRestoreArgs(uri: ParsedPgUri, inFile: string): string[] {
  return [
    '--no-password',
    '--host', uri.host,
    '--port', String(uri.port),
    '--username', uri.user,
    '--dbname', uri.dbname,
    inFile,
  ];
}

/** `pg_restore --list` — archive integrity check; touches no database. */
export function pgRestoreListArgs(inFile: string): string[] {
  return ['--list', inFile];
}

export interface ToolResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runPgTool(
  tool: 'pg_dump' | 'pg_restore',
  args: string[],
  uri: ParsedPgUri,
  opts: { maxStderrChars?: number } = {},
): Promise<ToolResult> {
  const max = opts.maxStderrChars ?? 4000;
  return new Promise((resolve, reject) => {
    const child = spawn(tool, args, {
      env: pgToolEnv(uri) as unknown as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < max) stderr += d.toString().slice(0, max - stderr.length);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      // pg_dump/pg_restore never echo credentials (they never receive any on
      // argv), but belt-and-braces: redact anything that looks like a URI.
      const redact = (t: string) => t.replace(/postgres(?:ql)?:\/\/[^\s"']+/g, 'postgres://[redacted]');
      resolve({ code: code ?? -1, stdout: redact(stdout), stderr: redact(stderr) });
    });
  });
}
