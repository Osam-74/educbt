/**
 * School backup registry checks. Compares src/lib/school-backup/registry.ts with the
 * REAL database, so the registry cannot drift from the schema.
 *   npx tsx src/db/test-school-backup-registry.ts
 * Run against a disposable LOCAL database; never production.
 */
import assert from 'node:assert/strict';
import postgres from 'postgres';
import {
  DATA_TABLES, EXCLUDED_TABLES, PLATFORM_TABLES, SCHOOL_TABLE, USER_STRIP, SCHOOL_STRIP, allClassifiedTables,
} from '@/lib/school-backup/registry';

async function main() {
  const url = new URL(process.env.DATABASE_URL_UNPOOLED ?? '');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_ca_test')) {
    throw new Error('Registry checks require a disposable local *_ca_test database.');
  }
  const sql = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1, onnotice: () => {} });
  let count = 0;
  const check = async (name: string, fn: () => unknown | Promise<unknown>) => { await fn(); count++; console.log('PASS  ' + name); };

  try {
    const tables = (await sql`select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE' and table_name not like '\\_\\_%' and table_name <> 'drizzle_migrations'`)
      .map((r) => r.table_name as string);
    const columns = new Map<string, Set<string>>();
    for (const r of await sql`select table_name, column_name from information_schema.columns where table_schema = 'public'`) {
      if (!columns.has(r.table_name)) columns.set(r.table_name, new Set());
      columns.get(r.table_name)!.add(r.column_name);
    }
    // pg_constraint, not information_schema: composite keys such as (staff_id, school_id) -> staff
    // must be read as ONE key whose tenant column (school_id) is not a reference to the parent's id.
    const fkRows = await sql`
      select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent,
             array(select a.attname from unnest(c.conkey) k join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k) as cols
      from pg_constraint c where c.contype = 'f' and c.connamespace = 'public'::regnamespace`;
    const fks: Array<{ child: string; col: string; parent: string }> = [];
    for (const r of fkRows) {
      const cols = (r.cols as string[]).filter((c) => c !== 'school_id');
      if (r.parent === 'schools') continue;
      for (const col of cols) fks.push({ child: r.child, col, parent: r.parent });
    }

    await check('every table in the database is classified', () => {
      const classified = new Set(allClassifiedTables());
      const missing = tables.filter((t) => !classified.has(t) && !t.startsWith('drizzle'));
      assert.deepEqual(missing, [], 'unclassified tables: ' + missing.join(', '));
    });

    await check('no table is classified twice', () => {
      const all = allClassifiedTables();
      const dupes = all.filter((t, i) => all.indexOf(t) !== i);
      assert.deepEqual(dupes, []);
    });

    await check('every classified table really exists', () => {
      const real = new Set(tables);
      const ghosts = allClassifiedTables().filter((t) => !real.has(t));
      assert.deepEqual(ghosts, [], 'registry names tables that do not exist: ' + ghosts.join(', '));
    });

    await check('every column named in the registry really exists', () => {
      const bad: string[] = [];
      for (const t of DATA_TABLES) for (const c of Object.keys(t.columns)) if (!columns.get(t.table)?.has(c)) bad.push(`${t.table}.${c}`);
      for (const c of Object.keys(USER_STRIP)) if (!columns.get('users')?.has(c)) bad.push('users.' + c);
      assert.deepEqual(bad, [], 'unknown columns: ' + bad.join(', '));
    });

    await check('every DATA table has school_id marked as the school column', () => {
      for (const t of DATA_TABLES) {
        assert.ok(columns.get(t.table)!.has('school_id'), t.table + ' has no school_id column');
        assert.equal(t.columns.school_id?.kind, 'school', t.table + ' must declare school_id');
      }
    });

    await check('every foreign key between DATA tables is declared as a ref to the right table', () => {
      const data = new Set(DATA_TABLES.map((t) => t.table));
      const missing: string[] = [];
      for (const f of fks) {
        if (!data.has(f.child) || f.parent === 'schools') continue;
        if (!data.has(f.parent)) continue; // points at a table we deliberately exclude: checked separately
        const rule = DATA_TABLES.find((t) => t.table === f.child)!.columns[f.col];
        if (!rule || rule.kind !== 'ref' || rule.table !== f.parent) missing.push(`${f.child}.${f.col} -> ${f.parent}`);
      }
      assert.deepEqual(missing, [], 'foreign keys not remapped (a restore would leave dangling ids): ' + missing.join('; '));
    });

    await check('no ref points at a table that is not in the backup', () => {
      const data = new Set(DATA_TABLES.map((t) => t.table));
      const bad: string[] = [];
      for (const t of DATA_TABLES) for (const [c, r] of Object.entries(t.columns)) if (r.kind === 'ref' && !data.has(r.table)) bad.push(`${t.table}.${c} -> ${r.table}`);
      assert.deepEqual(bad, []);
    });

    // Columns that LOOK like references but are not row ids. Anything else ending in _id/_by on a
    // backed-up table must be declared in the registry, or a restore would copy a dangling id.
    const NOT_A_REFERENCE: Record<string, string> = {
      'attempts.device_id': 'a browser device label, not a row',
      'grading_scale_versions.scale_id': 'a text label for the scale, not a row id',
      'subject_results.grading_scale_id': 'a text label for the scale, not a row id',
      'audit_log.entity_id': 'cleared on restore (points at many kinds of row)',
      'users.login_id': 'the sign-in name, not a row id',
      'announcements.audience_ref': 'remapped by the restore according to `audience`',
    };
    await check('every id-looking column on a backed-up table is declared (catches references with NO foreign key)', () => {
      const missing: string[] = [];
      for (const t of DATA_TABLES) {
        for (const col of columns.get(t.table)!) {
          const looksLikeRef = /(_id|_by)$/.test(col) && col !== 'school_id';
          if (!looksLikeRef) continue;
          if (t.columns[col] || NOT_A_REFERENCE[`${t.table}.${col}`]) continue;
          missing.push(`${t.table}.${col}`);
        }
      }
      assert.deepEqual(missing, [], 'undeclared reference-like columns (declare a ref, or explain in NOT_A_REFERENCE): ' + missing.join(', '));
    });

    await check('insert order puts every parent before its children', () => {
      const pos = new Map(DATA_TABLES.map((t, i) => [t.table, i]));
      const bad: string[] = [];
      for (const t of DATA_TABLES) for (const [c, r] of Object.entries(t.columns)) {
        // A table that points at ITSELF (questions.parent_id) cannot come "before" itself: the restore
        // inserts those rows first with the column empty, then fills it in a second pass.
        if (r.kind !== 'ref') continue;
        if (r.table === t.table) { assert.equal(r.nullable, true, `${t.table}.${c} is a self-reference and must be nullable`); continue; }
        if (pos.get(r.table)! >= pos.get(t.table)!) bad.push(`${t.table}.${c} needs ${r.table} first`);
      }
      assert.deepEqual(bad, [], bad.join('; '));
    });

    await check('every primary key column is declared (or the table has a composite key)', async () => {
      const bad: string[] = [];
      for (const t of DATA_TABLES) {
        const hasPk = Object.values(t.columns).some((r) => r.kind === 'pk');
        if (!hasPk && !['thread_participants', 'notification_prefs'].includes(t.table)) bad.push(t.table);
      }
      assert.deepEqual(bad, [], 'tables with no declared pk: ' + bad.join(', '));
    });

    await check('the only self-reference is questions.parent_id (needs the two-pass restore)', () => {
      const selfRefs = DATA_TABLES.flatMap((t) => Object.entries(t.columns).filter(([, r]) => r.kind === 'ref' && r.table === t.table).map(([c]) => `${t.table}.${c}`));
      assert.deepEqual(selfRefs, ['questions.parent_id']);
    });

    await check('credentials are never part of the backup', () => {
      for (const c of ['password_hash', 'totp_secret']) assert.ok(c in USER_STRIP, c + ' must be stripped');
      for (const t of ['sessions', 'password_reset_tokens', 'totp_recovery_codes']) assert.ok(t in EXCLUDED_TABLES, t + ' must be excluded');
      assert.equal(DATA_TABLES.find((t) => t.table === 'guardians')!.columns.invite_token?.kind, 'strip');
    });

    await check('the old school identity is never carried over', () => {
      for (const c of ['id', 'code', 'subdomain', 'custom_domain', 'id_prefix']) assert.ok((SCHOOL_STRIP as readonly string[]).includes(c), c);
      assert.equal(SCHOOL_TABLE, 'schools');
      assert.ok('platform_settings' in PLATFORM_TABLES);
    });

    console.log('\n' + count + ' checks passed.');
  } finally {
    await sql.end();
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
