/**
 * Secret-safe PostgreSQL connection-URI handling for backup tooling.
 *
 * Database URLs contain passwords. Everything in this module exists so that
 * the rest of the backup layer can work with a parsed URI *without* the
 * password ever reaching a log line, an error message or a command line.
 *
 * pg_dump / pg_restore receive connection parameters as separate arguments
 * (host, port, user, dbname) plus PGPASSWORD / PGSSLMODE via the process
 * environment — never a URI on the command line, where `ps` output or a
 * shell error echo would expose it.
 */

export interface ParsedPgUri {
  host: string;
  port: number;
  dbname: string;
  user: string;
  password: string;
  sslmode: string;
}

export class PgUriError extends Error {}

const KNOWN_SSLMODES = new Set(['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full']);

/**
 * Identity of a *database* (host + port + dbname) — used to compare target
 * databases while deliberately ignoring credentials, so "the same production
 * database reached through a different role" is still recognised as the same
 * target. Passwords never participate in comparisons and are never logged.
 */
export function dbIdentity(uri: string): string {
  const u = parsePgUri(uri);
  return `${u.host}:${u.port}/${u.dbname}`;
}

export function parsePgUri(raw: string | undefined, label = 'connection URI'): ParsedPgUri {
  if (!raw || !raw.trim()) {
    throw new PgUriError(`${label} is required.`);
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new PgUriError(`${label} is not a valid URI.`);
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) {
    throw new PgUriError(`${label} must be a postgres:// or postgresql:// URI.`);
  }
  const host = url.hostname;
  const dbname = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!host) throw new PgUriError(`${label} has no host.`);
  if (!dbname) throw new PgUriError(`${label} has no database name.`);
  const user = decodeURIComponent(url.username || 'postgres');
  if (!user) throw new PgUriError(`${label} has no user.`);
  const sslmode = (url.searchParams.get('sslmode') ?? '').trim();
  if (sslmode && !KNOWN_SSLMODES.has(sslmode)) {
    throw new PgUriError(`${label} has an unknown sslmode.`);
  }
  return {
    host,
    port: url.port ? Number(url.port) : 5432,
    dbname,
    user,
    // URL API percent-decodes password automatically.
    password: url.password,
    sslmode: sslmode || 'prefer',
  };
}

/**
 * Redacted description safe for logs and error messages.
 * Contains no password and no full URI.
 */
export function describePgUri(raw: string | undefined): string {
  try {
    const u = parsePgUri(raw);
    return `${u.user}@${u.host}:${u.port}/${u.dbname} (sslmode=${u.sslmode})`;
  } catch {
    return '(invalid connection URI)';
  }
}

/**
 * Environment variables to hand to pg_dump / pg_restore. The password and
 * sslmode travel through the process environment, never through argv, so
 * they cannot appear in `ps` listings or shell error echoes.
 */
export function pgToolEnv(uri: ParsedPgUri, inherit?: Record<string, string | undefined>): Record<string, string | undefined> {
  return { ...(inherit ?? process.env), PGPASSWORD: uri.password, PGSSLMODE: uri.sslmode };
}
