/**
 * Pure unit test for the restore's id-remapping rules. No database.
 *   npx tsx src/lib/school-backup/remap.test.ts
 */
import assert from 'node:assert/strict';
import {
  IdMap, remapRow, rewritePhotoPath, remapAudienceRef, remapSchoolSettings, remapVaultPayload,
  planPhotoTokens, newPhotoToken, assertKnownTables, RestoreIntegrityError,
} from './remap';
import { DATA_TABLES } from './registry';
import { buildDocument } from './format';

let count = 0;
const check = (name: string, fn: () => void) => { fn(); count++; console.log('PASS  ' + name); };
const spec = (t: string) => DATA_TABLES.find((x) => x.table === t)!;
const NEW_SCHOOL = 900;
const ctx = (ids = new IdMap(), extra: Record<string, unknown> = {}) => ({ newSchoolId: NEW_SCHOOL, ids, photoTokens: new Map<string, string>(), ...extra });

check('the primary key is dropped so the database assigns a fresh one', () => {
  const out = remapRow(spec('subjects'), { id: 7, school_id: 1, name: 'Maths', code: 'MTH', department_id: null }, ctx());
  assert.ok(!('id' in out));
});

check('the school id becomes the NEW school', () => {
  assert.equal(remapRow(spec('subjects'), { id: 7, school_id: 1, name: 'Maths', department_id: null }, ctx()).school_id, NEW_SCHOOL);
});

check('a reference is rewritten to the new id', () => {
  const ids = new IdMap(); ids.set('class_levels', 4, 444);
  const out = remapRow(spec('classes'), { id: 1, school_id: 1, level_id: 4, department_id: null, arm: 'A' }, ctx(ids));
  assert.equal(out.level_id, 444);
});

check('a REQUIRED reference to a row that is not in the backup is refused (broken file)', () => {
  assert.throws(() => remapRow(spec('classes'), { id: 1, school_id: 1, level_id: 4, department_id: null }, ctx()), RestoreIntegrityError);
});

check('a missing required reference (null) is refused', () => {
  assert.throws(() => remapRow(spec('classes'), { id: 1, school_id: 1, level_id: null, department_id: null }, ctx()), /must point at/);
});

check('an OPTIONAL reference to something not in the backup is cleared, not left dangling', () => {
  const ids = new IdMap(); ids.set('class_levels', 4, 444);
  const out = remapRow(spec('classes'), { id: 1, school_id: 1, level_id: 4, department_id: 99 }, ctx(ids));
  assert.equal(out.department_id, null);
});

check('scores keep pointing at the RIGHT student and subject (the no-foreign-key references)', () => {
  const ids = new IdMap();
  ids.set('students', 10, 1010); ids.set('subjects', 20, 2020); ids.set('academic_sessions', 30, 3030); ids.set('terms', 40, 4040);
  const out = remapRow(spec('assessment_scores'), { id: 1, school_id: 1, student_id: 10, subject_id: 20, session_id: 30, term_id: 40, component_key: 'ca1', score: '12.50', max_score: '20', entered_by: null }, ctx(ids));
  assert.deepEqual([out.student_id, out.subject_id, out.session_id, out.term_id], [1010, 2020, 3030, 4040]);
  assert.equal(out.score, '12.50', 'marks must stay exact');
});

check('compiled results are remapped the same way', () => {
  const ids = new IdMap();
  ids.set('students', 1, 11); ids.set('subjects', 2, 22); ids.set('academic_sessions', 3, 33); ids.set('terms', 4, 44);
  const out = remapRow(spec('subject_results'), { id: 9, school_id: 1, student_id: 1, subject_id: 2, session_id: 3, term_id: 4, total: '77.5' }, ctx(ids));
  assert.deepEqual([out.student_id, out.subject_id, out.session_id, out.term_id], [11, 22, 33, 44]);
});

check('a self-reference (question parent) is cleared for the second pass', () => {
  const ids = new IdMap(); ids.set('question_sets', 1, 11);
  const out = remapRow(spec('questions'), { id: 5, school_id: 1, question_set_id: 1, passage_id: null, parent_id: 4, reviewed_by: null }, ctx(ids));
  assert.equal(out.parent_id, null);
});

check('USERS: credentials are reset on every restored login', () => {
  const out = remapRow(spec('users'), { id: 1, school_id: 1, role: 'teacher', login_id: 't1', password_hash: 'LEAKED', totp_secret: 'LEAKED', totp_enabled: true, must_change_password: false, failed_attempts: 5 }, ctx());
  assert.ok(String(out.password_hash).startsWith('!restored-no-password!') && out.password_hash !== 'LEAKED'); assert.equal(out.totp_secret, null); assert.equal(out.totp_enabled, false);
  assert.equal(out.must_change_password, true); assert.equal(out.failed_attempts, 0);
});

check('USERS: an email already used elsewhere is cleared instead of colliding', () => {
  const taken = new Set(['ada@example.com']);
  const out = remapRow(spec('users'), { id: 1, school_id: 1, role: 'teacher', login_id: 't1', email: 'Ada@Example.com', email_verified_at: '2026-01-01' }, ctx(new IdMap(), { takenEmails: taken }));
  assert.equal(out.email, null); assert.equal(out.email_verified_at, null);
  const free = remapRow(spec('users'), { id: 2, school_id: 1, role: 'teacher', login_id: 't2', email: 'new@example.com' }, ctx(new IdMap(), { takenEmails: taken }));
  assert.equal(free.email, 'new@example.com');
});

check('GUARDIANS: the invite token is reset', () => {
  const out = remapRow(spec('guardians'), { id: 1, school_id: 1, full_name: 'Mr X', user_id: null, invite_token: 'OLD' }, ctx());
  assert.equal(out.invite_token, null);
});

check('PHOTOS: the path is rewritten to the new token', () => {
  const m = new Map([['oldtoken_abcdef12345', 'newtoken_zyxwvu98765']]);
  assert.equal(rewritePhotoPath('/api/photos/oldtoken_abcdef12345', m), '/api/photos/newtoken_zyxwvu98765');
  assert.equal(rewritePhotoPath('https://elsewhere.example/p.png', m), 'https://elsewhere.example/p.png');
  assert.equal(rewritePhotoPath(null, m), null);
});

check('PHOTOS: a path to a photo that is NOT in the backup is dropped, never kept pointing at someone else\'s upload', () => {
  assert.equal(rewritePhotoPath('/api/photos/notinthebackup0001', new Map()), null);
});

check('PHOTOS: every photo gets its own new, unguessable token', () => {
  const doc = buildDocument({ createdAt: 'x', credentials: 'none', app: { name: 'EduCBT', schemaTables: 1 }, school: {}, tables: {}, uploads: { a1111111111: { mimeType: 'image/png', base64: '' }, b2222222222: { mimeType: 'image/png', base64: '' } } });
  const plan = planPhotoTokens(doc);
  assert.equal(plan.size, 2);
  const [x, y] = [plan.get('a1111111111')!, plan.get('b2222222222')!];
  assert.notEqual(x, y); assert.notEqual(x, 'a1111111111');
  assert.match(x, /^[A-Za-z0-9_-]{20,}$/);
  assert.notEqual(newPhotoToken(), newPhotoToken());
});

check('ANNOUNCEMENTS: the audience reference follows the audience type', () => {
  const ids = new IdMap(); ids.set('classes', 5, 55); ids.set('class_levels', 5, 66); ids.set('departments', 5, 77);
  assert.equal(remapAudienceRef({ audience: 'class', audience_ref: 5 }, ids), 55);
  assert.equal(remapAudienceRef({ audience: 'level', audience_ref: 5 }, ids), 66);
  assert.equal(remapAudienceRef({ audience: 'department', audience_ref: 5 }, ids), 77);
  assert.equal(remapAudienceRef({ audience: 'role', audience_ref: 'teacher' }, ids), 'teacher');
  assert.equal(remapAudienceRef({ audience: 'class', audience_ref: 999 }, ids), null);
  assert.equal(remapAudienceRef({ audience: 'all', audience_ref: null }, ids), null);
});

check('SETTINGS: the question-bank series id points at the NEW series', () => {
  const ids = new IdMap(); ids.set('exam_series', 8, 88);
  const out = remapSchoolSettings({ css: 'x', questionBank: { seriesId: 8, other: 1 } }, ids) as { questionBank: { seriesId?: number; other: number }; css: string };
  assert.equal(out.questionBank.seriesId, 88); assert.equal(out.questionBank.other, 1); assert.equal(out.css, 'x');
  const gone = remapSchoolSettings({ questionBank: { seriesId: 12345 } }, ids) as { questionBank: { seriesId?: number } };
  assert.ok(!('seriesId' in gone.questionBank), 'a series not in the backup must not stay pointing at some other school');
});

check('SETTINGS: the original object is not mutated', () => {
  const ids = new IdMap(); ids.set('exam_series', 8, 88);
  const original = { questionBank: { seriesId: 8 } };
  remapSchoolSettings(original, ids);
  assert.equal(original.questionBank.seriesId, 8);
});

check('VAULT: ids embedded in a safety copy are rewritten so "restore this set" still works', () => {
  const ids = new IdMap(); ids.set('question_sets', 1, 101); ids.set('questions', 2, 202); ids.set('question_options', 3, 303); ids.set('passages', 4, 404);
  const out = remapVaultPayload({ version: 1, setId: 1, questions: [{ row: { id: 2, school_id: 1, question_set_id: 1, passage_id: 4, parent_id: null }, options: [{ id: 3, school_id: 1, question_id: 2, text: 'A' }] }] }, ids, NEW_SCHOOL) as {
    setId: number; questions: Array<{ row: Record<string, unknown>; options: Array<Record<string, unknown>> }> };
  assert.equal(out.setId, 101);
  assert.deepEqual([out.questions[0]!.row.id, out.questions[0]!.row.school_id, out.questions[0]!.row.question_set_id, out.questions[0]!.row.passage_id], [202, NEW_SCHOOL, 101, 404]);
  assert.deepEqual([out.questions[0]!.options[0]!.id, out.questions[0]!.options[0]!.question_id, out.questions[0]!.options[0]!.school_id], [303, 202, NEW_SCHOOL]);
  assert.equal(out.questions[0]!.options[0]!.text, 'A');
});

check('a file containing a table this version cannot restore is refused', () => {
  const ok = buildDocument({ createdAt: 'x', credentials: 'none', app: { name: 'EduCBT', schemaTables: 1 }, school: {}, tables: { students: [] }, uploads: {} });
  assert.doesNotThrow(() => assertKnownTables(ok));
  const bad = buildDocument({ createdAt: 'x', credentials: 'none', app: { name: 'EduCBT', schemaTables: 1 }, school: {}, tables: { students: [], mystery_table: [] }, uploads: {} });
  assert.throws(() => assertKnownTables(bad), /mystery_table/);
});

check('EVERY reference rule in the registry resolves through remapRow (no rule is silently ignored)', () => {
  for (const t of DATA_TABLES) {
    const ids = new IdMap(); const row: Record<string, unknown> = {};
    for (const [col, rule] of Object.entries(t.columns)) {
      if (rule.kind === 'ref') { if (rule.table !== t.table) ids.set(rule.table, 1, 1000); row[col] = 1; }
      if (rule.kind === 'pk' || rule.kind === 'school') row[col] = 1;
    }
    const out = remapRow(t, row, ctx(ids));
    for (const [col, rule] of Object.entries(t.columns)) {
      if (rule.kind === 'ref' && rule.table !== t.table) assert.equal(out[col], 1000, `${t.table}.${col} was not remapped`);
      if (rule.kind === 'school') assert.equal(out[col], NEW_SCHOOL, `${t.table}.${col} still points at the old school`);
    }
  }
});

console.log('\n' + count + ' checks passed.');
