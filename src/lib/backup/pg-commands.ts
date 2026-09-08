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
import { join } from 'node:path';
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

/**
 * pg_restore into a target database. No --clean: the target must be EMPTY.
 * --no-owner / --no-privileges: dumps taken in production name roles that
 * only exist there (neondb_owner, educbt_app). Restoring into any other
 * database must not fail on missing roles — objects become owned by the
 * restoring user, and app-role grants are re-established by the
 * provision-app-role step immediately after.
 */
export function pgRestoreArgs(uri: ParsedPgUri, inFile: string): string[] {
  return [
    '--no-owner',
    '--no-privileges',
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

/**
 * Resolve a pg client tool binary. On hosts with several client versions
 * (Ubuntu runners ship 16, PGDG installs 18) the /usr/bin wrappers do NOT
 * reliably pick the newest for server-less tools — pg_restore 16 rejects
 * PG 18 archive headers ("unsupported version (1.16)"). PG_BINDIR pins the
 * exact version; without it we fall back to PATH lookup (local dev).
 */
export function pgToolPath(tool: 'pg_dump' | 'pg_restore', env: Record<string, string | undefined> = process.env): string {
  const bindir = env.PG_BINDIR;
  return bindir ? join(bindir, tool) : tool;
}

export function runPgTool(
  tool: 'pg_dump' | 'pg_restore',
  args: string[],
  uri: ParsedPgUri,
  opts: { maxStderrChars?: number } = {},
): Promise<ToolResult> {
  const max = opts.maxStderrChars ?? 4000;
  return new Promise((resolve, reject) => {
    const child = spawn(pgToolPath(tool), args, {
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
