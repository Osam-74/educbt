/**
 * School backup EXPORT checks: a populated school is exported; the file must contain the
 * school's data, none of its credentials, and nothing from any other school.
 *   npx tsx src/db/test-school-backup-export.ts
 * Run against a disposable LOCAL database; never production.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';

async function main() {
  for (const key of ['DATABASE_URL_APP', 'DATABASE_URL_UNPOOLED']) {
    const url = new URL(process.env[key] ?? '');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_ca_test')) {
      throw new Error('Backup export tests require a disposable local *_ca_test database.');
    }
  }
  const { schema } = await import('@/db');
  const { exportSchool } = await import('@/lib/school-backup/export');
  const { decode } = await import('@/lib/school-backup/format');
  const { DATA_TABLES } = await import('@/lib/school-backup/registry');

  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1, onnotice: () => {} });
  const db = drizzle(owner, { schema });
  const schoolIds: number[] = [];
  let count = 0;
  const check = async (name: string, fn: () => unknown | Promise<unknown>) => { await fn(); count++; console.log('PASS  ' + name); };

  const SECRET_HASH = 'argon2id$SUPER-SECRET-HASH-' + randomUUID();
  const TOTP = 'TOTPSECRET' + randomUUID().replace(/-/g, '').slice(0, 12);

  async function populate(label: string) {
    const code = 'B' + randomUUID().slice(0, 6).toUpperCase();
    const [school] = await db.insert(schema.schools).values({
      name: label, code, subdomain: code.toLowerCase(), address: '1 Palm Road', logoUrl: null, settings: { assessmentComponents: [], css: 'x' },
    }).returning();
    const schoolId = school!.id; schoolIds.push(schoolId);

    const [session] = await db.insert(schema.academicSessions).values({ schoolId, title: '2025/26', isCurrent: true }).returning();
    const [term] = await db.insert(schema.terms).values({ schoolId, sessionId: session!.id, title: 'First', position: 1, isCurrent: true }).returning();
    const [level] = await db.insert(schema.classLevels).values({ schoolId, name: 'SS1' }).returning();
    const [klass] = await db.insert(schema.classes).values({ schoolId, levelId: level!.id, displayName: 'SS1 A', arm: 'A' }).returning();
    const [subject] = await db.insert(schema.subjects).values({ schoolId, name: 'Biology', code: 'BIO', isCompulsory: false }).returning();

    const [tUser] = await db.insert(schema.users).values({ schoolId, role: 'teacher', loginId: 't-' + code, passwordHash: SECRET_HASH, totpSecret: TOTP, totpEnabled: true, mustChangePassword: false, failedAttempts: 3 }).returning();
    const [teacher] = await db.insert(schema.staff).values({ schoolId, userId: tUser!.id, role: 'teacher', staffNumber: 'T1', firstName: 'Tunde', lastName: 'Bello' }).returning();
    await db.insert(schema.staffAssignments).values({ schoolId, staffId: teacher!.id, classId: klass!.id, subjectId: subject!.id, assignmentType: 'subject_teacher' });

    const photoToken = randomUUID().replace(/-/g, '') + 'ab';
    await db.insert(schema.portalUploads).values({ schoolId, token: photoToken, mimeType: 'image/png', byteSize: 4, data: Buffer.from([1, 2, 3, 4]) });
    const [sUser] = await db.insert(schema.users).values({ schoolId, role: 'student', loginId: 's-' + code, passwordHash: SECRET_HASH, mustChangePassword: false }).returning();
    const [student] = await db.insert(schema.students).values({ schoolId, userId: sUser!.id, admissionNumber: 'ADM/' + code, firstName: 'Ada', lastName: 'Obi', photoUrl: '/api/photos/' + photoToken }).returning();
    await db.insert(schema.enrollments).values({ schoolId, studentId: student!.id, classId: klass!.id, sessionId: session!.id });
    await db.insert(schema.studentSubjects).values({ schoolId, studentId: student!.id, subjectId: subject!.id, sessionId: session!.id });
    await db.insert(schema.guardians).values({ schoolId, fullName: 'Mr Obi', inviteToken: 'INVITE-' + randomUUID() });
    await db.insert(schema.assessmentScores).values({ schoolId, studentId: student!.id, subjectId: subject!.id, sessionId: session!.id, termId: term!.id, componentKey: 'ca1', score: '12', maxScore: '20' });
    await db.insert(schema.passwordResetTokens).values({ schoolId, userId: tUser!.id, tokenHash: 'RESETHASH-' + randomUUID(), expiresAt: new Date(Date.now() + 3600e3) });
    await db.insert(schema.emailEvents).values({ schoolId, toEmail: 'parent@example.com', subject: 'queued', body: 'queued body' });
    return { schoolId, code, photoToken, studentId: student!.id, teacherId: teacher!.id };
  }

  try {
    const a = await populate('Greenfield College');
    const b = await populate('Other Academy');

    const out = await exportSchool(a.schoolId);
    const doc = decode(out.file);
    const text = JSON.stringify(doc);

    await check('the export opens and verifies', () => { assert.equal(doc.format, 'educbt-school-backup'); assert.ok(out.file.length > 100); });
    await check('the school and its people are in the file', () => {
      assert.equal(doc.school.name, 'Greenfield College');
      assert.equal(doc.tables.students!.length, 1);
      assert.equal(doc.tables.staff!.length, 1);
      assert.equal(doc.tables.staff_assignments!.length, 1);
      assert.equal(doc.tables.assessment_scores!.length, 1);
      assert.equal(doc.tables.users!.length, 2);
    });
    await check('every registered table is present in the file (even when empty)', () => {
      for (const t of DATA_TABLES) assert.ok(Array.isArray(doc.tables[t.table]), t.table + ' missing from the file');
    });
    await check('NO password hash anywhere in the file', () => { assert.ok(!text.includes(SECRET_HASH), 'password hash leaked'); assert.ok(!text.includes('password_hash')); });
    await check('NO two-factor secret anywhere in the file', () => { assert.ok(!text.includes(TOTP), 'totp secret leaked'); assert.ok(!text.includes('totp_secret')); });
    await check('NO reset token, session or queued email in the file', () => {
      assert.ok(!text.includes('RESETHASH-')); assert.ok(!text.includes('token_hash'));
      assert.ok(!('password_reset_tokens' in doc.tables) && !('sessions' in doc.tables) && !('email_events' in doc.tables) && !('totp_recovery_codes' in doc.tables));
      assert.ok(!text.includes('queued body'));
    });
    await check('NO guardian invite token in the file', () => { assert.ok(!text.includes('INVITE-')); assert.ok(!('invite_token' in doc.tables.guardians![0]!)); });
    await check('the old school identity is not carried (code, subdomain, id)', () => {
      for (const c of ['id', 'code', 'subdomain', 'custom_domain', 'id_prefix', 'status', 'created_at', 'updated_at']) assert.ok(!(c in doc.school), c + ' must not be in the school object');
      // (login ids and admission numbers in this fixture are built from the code, so the code can
      // legitimately appear inside those values; what matters is that the school's own fields are gone)
      assert.ok(!JSON.stringify(doc.school).includes(a.code));
    });
    await check('NOTHING from another school is in the file', () => {
      assert.ok(!text.includes('Other Academy')); assert.ok(!text.includes(b.code));
      for (const [t, rows] of Object.entries(doc.tables)) for (const r of rows) {
        if ('school_id' in r) assert.equal(r.school_id, a.schoolId, `${t} contains a row from another school`);
      }
    });
    await check('the photo bytes travel in the file, keyed by their old token', () => {
      assert.deepEqual(Object.keys(doc.uploads), [a.photoToken]);
      assert.equal(Buffer.from(doc.uploads[a.photoToken]!.base64, 'base64').toString('hex'), '01020304');
      assert.ok(!('data' in doc.tables.portal_uploads![0]!), 'raw bytes must not be duplicated in the table rows');
    });
    await check('the student still points at the photo path (rewritten on restore)', () => {
      assert.equal(doc.tables.students![0]!.photo_url, '/api/photos/' + a.photoToken);
    });
    await check('two exports of unchanged data differ only in their timestamp', async () => {
      const again = decode((await exportSchool(a.schoolId)).file);
      assert.deepEqual(again.tables, doc.tables);
      assert.deepEqual(again.uploads, doc.uploads);
    });
    await check('portal_uploads (public-read policy) is protected by the filter AND the abort guard', async () => {
      // The table holding photos has a public-read RLS policy, so RLS alone would hand the export
      // every school's photos. Prove the policy really is that permissive (so the guard is needed)...
      const visible = await owner`select count(*)::int as n from portal_uploads where school_id = ${b.schoolId}`;
      assert.equal(visible[0]!.n, 1);
      // ...and that the export still contains only this school's photo.
      assert.deepEqual(Object.keys(doc.uploads), [a.photoToken]);
      assert.ok(!(b.photoToken in doc.uploads), 'another school\'s photo is in the file');
      // The guard itself must stay in the source: removing it must be a deliberate, visible act.
      const { readFileSync } = await import('node:fs');
      assert.match(readFileSync('src/lib/school-backup/export.ts', 'utf8'), /Backup aborted: \$\{spec\.table\} returned a row from another school/);
    });
    await check('exporting a school that does not exist fails cleanly', async () => {
      await assert.rejects(() => exportSchool(999999999), /does not exist/);
    });

    console.log('\n' + count + ' checks passed.');
  } finally {
    for (const id of schoolIds) await db.delete(schema.schools).where(eq(schema.schools.id, id)).catch(() => {});
    await owner.end();
    const { client } = await import('@/db'); await client.end({ timeout: 2 }).catch(() => {});
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
