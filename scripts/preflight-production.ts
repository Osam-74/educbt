/**
 * scripts/preflight-production.ts — safety gate before touching production.
 *
 * Run against DATABASE_URL_UNPOOLED BEFORE the first production migration.
 * It proves the connection is what the migration step assumes, and refuses
 * to continue otherwise:
 *
 *   1. connects with the configured URL (sslmode=verify-full enforced —
 *      see docs/postgres-provider-decision.md → TLS)
 *   2. the server is the expected PostgreSQL major (PG_MAJOR)
 *   3. the endpoint is the DIRECT host, not the -pooler one (DDL needs a
 *      real session; PgBouncer cannot run session-level statements)
 *   4. TLS is actually in use AND the certificate is verified — proven
 *      CLIENT-SIDE on the live socket (see TLS note below)
 *   5. the database is EMPTY of user tables (suitable for first migration)
 *   6. the educbt_app role does not exist yet (or already-provisioned is
 *      reported, so a re-run is a no-op rather than a surprise)
 *
 * It never prints the connection string or password — describePgUri() is
 * the only permitted URI output (user@host:port/dbname, no credentials).
 *
 *   DATABASE_URL_UNPOOLED=... PG_MAJOR=18 npx tsx scripts/preflight-production.ts
 */

import { Client } from 'pg';
import type { TLSSocket } from 'node:tls';
import postgres from 'postgres';
import { parsePgUri, describePgUri } from '../src/lib/backup/pg-uri';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function fail(message: string): never {
  console.error(`FAIL  ${message}`);
  process.exit(1);
}

function info(message: string) {
  console.log(`INFO  ${message}`);
}

async function main() {
  const url = process.env.DATABASE_URL_UNPOOLED;
  if (!url) fail('DATABASE_URL_UNPOOLED is required (the direct/owner endpoint, never the -pooler host).');

  const pgMajor = Number(process.env.PG_MAJOR ?? '');
  if (!Number.isInteger(pgMajor) || pgMajor < 13) {
    fail('PG_MAJOR (repository variable) must be set to the production PostgreSQL major version, e.g. 18.');
  }

  let uri;
  try {
    uri = parsePgUri(url, 'DATABASE_URL_UNPOOLED');
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  if (uri.sslmode !== 'verify-full') {
    // postgres.js maps sslmode=require to rejectUnauthorized:false — encrypted
    // but unverified, i.e. open to interception. Production refuses that.
    fail(`sslmode=verify-full is required for production connections (found sslmode=${uri.sslmode}).`);
  }

  const isLocal = LOCAL_HOSTS.has(uri.host.toLowerCase());
  if (uri.host.includes('-pooler') && !isLocal) {
    fail('This looks like the POOLED (-pooler) endpoint. Migrations and DDL need the direct endpoint; the pooler cannot run session-level statements.');
  }

  info(`target: ${describePgUri(url)}`);

  // postgres.js honours sslmode=verify-full from the URL with full certificate
  // verification; nothing extra to configure at the client.
  const sql = postgres(url, { max: 1 });

  try {
    // ── 1. Server version ────────────────────────────────────────────────────
    const [version] = await sql<{ version: string }[]>`SELECT version()`;
    const match = /PostgreSQL (\d+)/.exec(version?.version ?? '');
    const serverMajor = match ? Number(match[1]) : NaN;
    if (serverMajor !== pgMajor) {
      fail(`server is PostgreSQL ${serverMajor}, but PG_MAJOR=${pgMajor}. pg_dump/pg_restore format and SQL dialect must match production — fix the variable or the target.`);
    }
    info(`server version: PostgreSQL ${serverMajor} (matches PG_MAJOR=${pgMajor})`);

    // ── 2. TLS is real and verified (client-side proof) ────────────────────────
    // pg_stat_ssl on the SERVER is not authoritative on Neon: Neon's proxy
    // terminates TLS and forwards plaintext to the compute, so pg_stat_ssl can
    // report the internal hop as non-SSL even when the client connection is
    // fully encrypted (observed on the production endpoint, 2026-09-08 —
    // Neon rejects unencrypted connections outright). The client-side socket
    // is where encryption and verification actually happen, so prove it there:
    // connect with rejectUnauthorized:true — the semantics libpq applies to
    // sslmode=verify-full, which the URL already mandates above — and inspect
    // the live TLS stream.
    const tlsClient = new Client({
      host: uri.host,
      port: uri.port,
      database: uri.dbname,
      user: uri.user,
      password: uri.password,
      ssl: { rejectUnauthorized: true },
    });
    await tlsClient.connect();
    const stream = tlsClient.connection?.stream as TLSSocket | undefined;
    if (!stream || typeof stream.getPeerCertificate !== 'function') {
      await tlsClient.end().catch(() => {});
      fail('TLS proof: the live connection is NOT a TLS socket — encryption is not in use.');
    }
    if (!stream.authorized) {
      await tlsClient.end().catch(() => {});
      fail('TLS proof: connected, but the server certificate was NOT verified. Must never happen with rejectUnauthorized — investigate.');
    }
    const cert = stream.getPeerCertificate();
    info(`TLS proven client-side: ${stream.getProtocol()} — chain verified against system CAs, hostname checked`);
    if (cert && Object.keys(cert).length > 0) {
      info(`server certificate: CN=${(cert.subject as { CN?: string } | undefined)?.CN ?? 'unknown'}, issuer=${(cert.issuer as { O?: string; CN?: string } | undefined)?.O ?? (cert.issuer as { CN?: string } | undefined)?.CN ?? 'unknown'}, valid_to=${cert.valid_to}`);
    }
    await tlsClient.end();

    // Informational only (NOT a gate): the server-side view of TLS. Behind
    // Neon's proxy this commonly reports the internal hop, i.e. ssl=false —
    // that is expected and does not reflect the client connection (proven
    // above). On a self-managed server it confirms end-to-end TLS.
    const [ssl] = await sql<{ ssl: boolean; version: string }[]>`
      SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid()`;
    info(`server-side pg_stat_ssl: ssl=${ssl?.ssl ?? 'no row'} (${ssl?.version ?? '—'}) — informational only behind a TLS-terminating proxy`);

    // ── 3. Empty database (first-migration suitability) ──────────────────────
    const [tables] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`;
    if ((tables?.n ?? 0) > 0) {
      fail(`expected an empty public schema for first migration, found ${tables?.n} table(s). Refusing to run against a database that was not created for this purpose — investigate manually.`);
    }
    info('public schema has 0 user tables — suitable for first migration');

    // ── 4. App role status ────────────────────────────────────────────────────
    const [role] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_roles WHERE rolname = 'educbt_app'`;
    info(
      (role?.n ?? 0) === 0
        ? 'role educbt_app does not exist yet — provisioning step will create it'
        : 'role educbt_app already exists — provisioning step is idempotent and will only refresh grants',
    );

    // ── 5. Endpoint report for wiring DATABASE_URL_APP ────────────────────────
    // Hostnames are not credentials (describePgUri already logs them); the
    // password never appears. The maintainer composes the app-role secret from
    // these + the role password held in the secret store.
    if (!isLocal) {
      const pooledHost = uri.host.includes('-pooler') ? uri.host : `${uri.host.replace(/\.neon\.tech$/, '')}-pooler.neon.tech`;
      console.log('\nEndpoint report (hostnames only — no credentials):');
      console.log(`  direct (migrations/tooling): ${uri.host}`);
      console.log(`  pooled (application runtime): ${pooledHost}`);
      console.log(`  database: ${uri.dbname}`);
      console.log('\nNext: DATABASE_URL_APP = postgresql://educbt_app:<password>@<pooled host>/' + uri.dbname + '?sslmode=verify-full');
    }

    console.log('\nPreflight OK. Safe to run migrations.');
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error('Preflight error:', err);
  process.exit(1);
});
