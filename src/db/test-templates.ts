/**
 * Per-school document templates suite.
 *
 *   npm run test:templates
 *
 * LOCAL DISPOSABLE DATABASE ONLY. Refuses to run against anything that is not 127.0.0.1 / localhost.
 *
 *   1. A platform admin can set a school's templates; a principal cannot, by the SERVICE and by the DATABASE policy.
 *   2. A school reads its own row and never another school's.
 *   3. Resolution: the school's value, else the platform default, else classic; a removed key falls back safely.
 *   4. An unknown or empty key is rejected (and an empty one is only allowed as "inherit").
 *   5. Creating a school with designs stores them in the same transaction; an invalid key creates NOTHING.
 *   6. Every change writes an audit row with before and after.
 *   7. A school created with no designs follows the platform default.
 */
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, inArray } from 'drizzle-orm';
import * as core from './schema/core';
import * as people from './schema/people';
import { hashPassword } from '@/lib/auth/password';
import { forSchool, db, schema as appSchema } from '@/db';
import type { PlatformActor } from '@/lib/platform/session';
import { createSchoolWithPrincipal, PlatformPermissionError } from '@/lib/platform/schools';
import {
  getDocumentTemplates, setSchoolTemplates, setPlatformDefaultTemplates, TemplateError, viewTemplateAssignments,
} from '@/lib/templates/service';
import { resolveTemplate, isTemplateKey, TEMPLATES } from '@/lib/templates/registry';

const schema = { ...core, ...people };
let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};
const rejects = async (fn: () => Promise<unknown>, type?: new (...a: never[]) => Error) => {
  try { await fn(); return false; } catch (e) { return type ? e instanceof type : true; }
};

const CODES = ['TPL-A', 'TPL-B', 'TPL-NEW', 'TPL-BAD', 'TPL-NONE'];
const actorOf = (userId: number): PlatformActor => ({ userId, loginId: 'TPL-ADMIN', role: 'platform_admin' });

async function main() {
  const ownerUrl = process.env.DATABASE_URL_UNPOOLED ?? '';
  if (!/@(127\.0\.0\.1|localhost)[:/]/.test(ownerUrl)) throw new Error('Refusing to run: DATABASE_URL_UNPOOLED is not a local database.');
  const owner = postgres(ownerUrl, { max: 1 });
  const odb = drizzle(owner, { schema });

  await odb.delete(core.schools).where(inArray(core.schools.code, CODES));
  await odb.delete(people.users).where(and(eq(people.users.loginId, 'TPL-ADMIN'), eq(people.users.role, 'platform_admin')));
  const [admin] = await odb.insert(people.users).values({
    schoolId: null, role: 'platform_admin', loginId: 'TPL-ADMIN', passwordHash: await hashPassword('Fixt-Tpl!2345'),
    mustChangePassword: false, status: 'active',
  }).returning({ id: people.users.id });
  const adminId = Number(admin!.id);
  const actor = actorOf(adminId);
  const wrong = (role: string) => ({ userId: adminId, loginId: `TPL-${role}`, role }) as never;

  // Start from a known platform default, whatever an earlier run left behind.
  await owner`UPDATE platform_settings SET default_report_template='classic', default_transcript_template='classic', default_broadsheet_template='classic' WHERE id = 1`;
  await owner`INSERT INTO platform_settings (id) VALUES (1) ON CONFLICT DO NOTHING`;

  const mk = async (code: string, name: string, templates?: Record<string, string>) => createSchoolWithPrincipal(actor, {
    name, code, status: 'active', principalFirstName: 'Test', principalLastName: code, principalLoginId: `${code.toLowerCase()}.p`,
  }, undefined, templates);

  try {
    // ── 5/7. creation with and without designs ────────────────────────────────
    const a = await mk('TPL-A', 'Template Fixture A', { report: 'heritage', transcript: 'metro', broadsheet: 'ledger' });
    const b = await mk('TPL-B', 'Template Fixture B');
    const idA = a.school.id, idB = b.school.id;
    const rowA = (await owner`SELECT * FROM school_document_templates WHERE school_id = ${idA}`)[0];
    check('creating a school with designs stores them (5)', rowA?.report_template === 'heritage' && rowA?.transcript_template === 'metro' && rowA?.broadsheet_template === 'ledger');
    const rowB = await owner`SELECT * FROM school_document_templates WHERE school_id = ${idB}`;
    check('creating a school with none stores no row; it follows the platform default (7)', rowB.length === 0);
    const createdAudit = (await owner`SELECT after FROM audit_log WHERE school_id = ${idA} AND action = 'school.created'`)[0];
    check('the creation audit row records the chosen designs (6)', createdAudit?.after?.templates?.report === 'heritage');

    // invalid key: the whole registration is refused and NOTHING is created
    const before = (await owner`SELECT count(*)::int AS n FROM schools WHERE code = 'TPL-BAD'`)[0]!.n;
    const refused = await rejects(() => mk('TPL-BAD', 'Template Fixture Bad', { report: 'heritage', transcript: 'neon-pink', broadsheet: 'classic' }), TemplateError);
    const afterN = (await owner`SELECT count(*)::int AS n FROM schools WHERE code = 'TPL-BAD'`)[0]!.n;
    const usersBad = (await owner`SELECT count(*)::int AS n FROM users WHERE login_id = 'tpl-bad.p'`)[0]!.n;
    check('an unknown key refuses the registration (5)', refused);
    check('...and creates no school and no principal (5)', before === 0 && afterN === 0 && usersBad === 0);
    check('an empty key is refused at registration (nothing to inherit yet) (4)', await rejects(() => mk('TPL-BAD', 'Template Fixture Bad', { report: '', transcript: 'classic', broadsheet: 'classic' }), TemplateError));
    check('a missing document type is refused at registration (4)', await rejects(() => mk('TPL-BAD', 'Template Fixture Bad', { report: 'classic', transcript: 'classic' }), TemplateError));

    // The write policies must carry a USING clause as well as WITH CHECK, or an UPDATE / upsert matches no row and the
    // platform defaults can never be saved. Asserted on the catalog so a stale rls.sql is named, not discovered as a crash.
    const pol = await owner`SELECT tablename, policyname, qual IS NOT NULL AS has_using, with_check IS NOT NULL AS has_check FROM pg_policies WHERE (tablename = 'platform_settings' AND policyname = 'branding_platform_admin_write') OR (tablename = 'school_document_templates' AND policyname = 'platform_admin_write')`;
    check('both write policies have USING and WITH CHECK (so updates and upserts work)', pol.length === 2 && pol.every((r) => r.has_using && r.has_check), pol.map((r) => `${r.policyname}:${r.has_using}/${r.has_check}`).join(' '));

    // ── 1. who may write ─────────────────────────────────────────────────────
    await setSchoolTemplates(actor, idB, { report: 'royal', transcript: '', broadsheet: 'bright' });
    const rowB2 = (await owner`SELECT * FROM school_document_templates WHERE school_id = ${idB}`)[0];
    check('a platform admin can set a school\'s templates; blank = inherit (1)', rowB2?.report_template === 'royal' && rowB2?.transcript_template === null && rowB2?.broadsheet_template === 'bright');
    for (const role of ['principal', 'exam_officer', 'teacher', 'student', 'parent']) {
      check(`${role} is refused by the SERVICE (1)`, await rejects(() => setSchoolTemplates(wrong(role), idB, { report: 'royal' }), PlatformPermissionError));
    }
    check('a school actor is refused the platform defaults too (1)', await rejects(() => setPlatformDefaultTemplates(wrong('principal'), { report: 'royal', transcript: 'royal', broadsheet: 'royal' }), PlatformPermissionError));
    // The DATABASE policy, independent of the service: a tenant session cannot write its own row.
    const writeAsSchool = await rejects(() => forSchool(idB, async (tx) => {
      await tx.update(appSchema.schoolDocumentTemplates).set({ reportTemplate: 'ledger' }).where(eq(appSchema.schoolDocumentTemplates.schoolId, idB)).returning();
      const [now] = await tx.select().from(appSchema.schoolDocumentTemplates).where(eq(appSchema.schoolDocumentTemplates.schoolId, idB));
      if (now?.reportTemplate === 'ledger') return;               // the write took effect: the policy failed
      throw new Error('no effect');                                // 0 rows changed: the policy hid the row from writes
    }));
    const stillRoyal = (await owner`SELECT report_template FROM school_document_templates WHERE school_id = ${idB}`)[0]?.report_template;
    check('a school session cannot change its own design: the database policy refuses it (1)', writeAsSchool && stillRoyal === 'royal', String(stillRoyal));
    const insertAsSchool = await rejects(() => forSchool(idA, async (tx) => {
      await tx.insert(appSchema.schoolDocumentTemplates).values({ schoolId: idA, reportTemplate: 'bright' }).onConflictDoUpdate({ target: appSchema.schoolDocumentTemplates.schoolId, set: { reportTemplate: 'bright' } });
    }));
    const stillHeritage = (await owner`SELECT report_template FROM school_document_templates WHERE school_id = ${idA}`)[0]?.report_template;
    check('...nor insert or upsert one (1)', insertAsSchool && stillHeritage === 'heritage', String(stillHeritage));

    // ── 2. tenant reads ──────────────────────────────────────────────────────
    const seenByA = await forSchool(idA, (tx) => tx.select().from(appSchema.schoolDocumentTemplates));
    check('a school reads its own row and cannot see another school\'s (2)', seenByA.length === 1 && Number(seenByA[0]!.schoolId) === idA);

    // ── 3. resolution ────────────────────────────────────────────────────────
    const resA = await forSchool(idA, (tx) => getDocumentTemplates(tx, idA));
    check('own choices win (3)', resA.report === 'heritage' && resA.transcript === 'metro' && resA.broadsheet === 'ledger');
    await setPlatformDefaultTemplates(actor, { report: 'bright', transcript: 'royal', broadsheet: 'metro' });
    const resB = await forSchool(idB, (tx) => getDocumentTemplates(tx, idB));
    check('a blank choice follows the platform default; a set one does not (3)', resB.report === 'royal' && resB.transcript === 'royal' && resB.broadsheet === 'bright', JSON.stringify(resB));
    const none = await mk('TPL-NONE', 'Template Fixture None');
    const resN = await forSchool(none.school.id, (tx) => getDocumentTemplates(tx, none.school.id));
    check('a school with no row at all gets the platform default (3)', resN.report === 'bright' && resN.transcript === 'royal' && resN.broadsheet === 'metro');
    await owner`UPDATE platform_settings SET default_report_template='classic', default_transcript_template='classic', default_broadsheet_template='classic' WHERE id = 1`;
    const resC = await forSchool(none.school.id, (tx) => getDocumentTemplates(tx, none.school.id));
    check('with the platform default on classic, a school with no row is classic (3)', resC.report === 'classic' && resC.transcript === 'classic' && resC.broadsheet === 'classic');
    await owner`UPDATE school_document_templates SET report_template = 'retired-design' WHERE school_id = ${idA}`;
    const resR = await forSchool(idA, (tx) => getDocumentTemplates(tx, idA));
    check('a stored key that no longer exists falls back safely, never breaking printing (3)', resR.report === 'classic' && resR.transcript === 'metro');
    check('resolveTemplate: school, else platform, else classic (3)', resolveTemplate('royal', 'metro') === 'royal' && resolveTemplate(null, 'metro') === 'metro' && resolveTemplate(undefined, undefined) === 'classic' && resolveTemplate('nope', 'nope') === 'classic');

    // ── 4. validation on the edit paths ──────────────────────────────────────
    check('an unknown key is rejected on a school edit (4)', await rejects(() => setSchoolTemplates(actor, idB, { report: 'neon-pink' }), TemplateError));
    check('an unknown key is rejected on the platform defaults (4)', await rejects(() => setPlatformDefaultTemplates(actor, { report: 'neon-pink', transcript: 'classic', broadsheet: 'classic' }), TemplateError));
    check('a blank is rejected on the platform defaults: there is nothing to inherit from (4)', await rejects(() => setPlatformDefaultTemplates(actor, { report: '', transcript: 'classic', broadsheet: 'classic' }), TemplateError));
    check('an unknown school is a clean error (4)', await rejects(() => setSchoolTemplates(actor, 99999999, { report: 'royal' }), TemplateError));
    check('every registered key is valid and nothing else is (4)', TEMPLATES.every((t) => isTemplateKey(t.key)) && !isTemplateKey('') && !isTemplateKey(null) && !isTemplateKey(7));
    const changedNothing = (await owner`SELECT report_template FROM school_document_templates WHERE school_id = ${idB}`)[0]?.report_template;
    check('a rejected edit changed nothing (4)', changedNothing === 'royal', String(changedNothing));

    // ── 6. audit ─────────────────────────────────────────────────────────────
    await setSchoolTemplates(actor, idB, { report: 'ledger' });
    const au = (await owner`SELECT before, after, actor_user_id FROM audit_log WHERE school_id = ${idB} AND action = 'school.templates_changed' ORDER BY id DESC LIMIT 1`)[0];
    check('a school edit writes an audit row with before and after (6)', au?.before?.reportTemplate === 'royal' && au?.after?.reportTemplate === 'ledger' && Number(au?.actor_user_id) === adminId);
    await setPlatformDefaultTemplates(actor, { report: 'metro', transcript: 'classic', broadsheet: 'classic' });
    const au2 = (await owner`SELECT before, after FROM audit_log WHERE action = 'platform.default_templates_changed' ORDER BY id DESC LIMIT 1`)[0];
    check('a platform default change writes an audit row with before and after (6)', au2?.before?.report === 'classic' && au2?.after?.report === 'metro');
    const view = await viewTemplateAssignments(actor, idB);
    check('the admin view reports stored choices and the defaults (6)', view.own?.report === 'ledger' && view.own?.transcript === null && view.defaults.report === 'metro');
    check('the admin view is refused to a non-platform actor (1)', await rejects(() => viewTemplateAssignments(wrong('principal'), idB), PlatformPermissionError));
  } finally {
    await owner`UPDATE platform_settings SET default_report_template='classic', default_transcript_template='classic', default_broadsheet_template='classic' WHERE id = 1`;
    await odb.delete(core.schools).where(inArray(core.schools.code, CODES));
    await odb.delete(people.users).where(and(eq(people.users.loginId, 'TPL-ADMIN'), eq(people.users.role, 'platform_admin')));
    const left = await owner`SELECT count(*)::int AS n FROM schools WHERE code LIKE 'TPL-%'`;
    check('fixture cleanup is complete and rerun-safe', left[0]!.n === 0);
    await owner.end();
    await db.$client.end({ timeout: 2 }).catch(() => {});
  }

  console.log('');
  if (failures > 0) { console.log(`${failures} check(s) FAILED.`); process.exit(1); }
  console.log('All document-template checks passed.');
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
