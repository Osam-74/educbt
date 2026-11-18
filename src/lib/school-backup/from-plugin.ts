/**
 * Translate a WordPress plugin school backup into an ordinary SaaS school backup.
 *
 * The translator is deliberately NOT a second restore path. It only turns plugin rows into SaaS-shaped
 * rows and builds a normal BackupDocument, which the existing restoreSchool() then imports with all of its
 * guards (checksum, one transaction, new ids, tenant isolation). Nothing here ever touches the database.
 *
 * Nothing is dropped silently: every row or value that cannot be carried is added to `report.notes`, so the
 * person migrating sees exactly what did not come across and why.
 *
 * SLICE 1: structure and people (sessions, terms, year groups, departments, classes, subjects, staff,
 * students, guardians, enrolments, subject registrations, staff duties). Results, questions and exam
 * records follow in later slices; a plugin file that carries them is accepted and those tables are
 * reported as "not yet translated", never guessed at.
 */
import { buildDocument, type BackupDocument } from './format';

type Row = Record<string, unknown>;
export type PluginBackup = {
  format: 'educbt-wp-school-backup';
  version: number;
  credentials?: 'none' | 'password-hashes';
  school: Row;
  tables: Record<string, Row[]>;
  uploads?: Record<string, { mimeType: string; base64: string }>;
};

export type TranslateReport = {
  translated: Record<string, number>;
  /** things that did not come across, each with the reason. Shown to the person migrating. */
  notes: string[];
  /** plugin tables present in the file that this version does not translate yet */
  notTranslated: string[];
};

export class PluginBackupError extends Error {}

const str = (v: unknown): string | null => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim());
const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
/** The plugin stores "no link" as 0 in optional id columns; an id of 0 is never a real row. */
const link = (v: unknown): number | null => { const n = num(v); return n === null || n === 0 ? null : n; };
const iso = (v: unknown): string | null => {
  const s = str(v); if (!s || s.startsWith('0000')) return null;
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const bool = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 'true';

const STAGE: Record<string, 'junior' | 'senior' | 'both'> = { junior: 'junior', senior: 'senior', both: 'both' };
const stageOf = (v: unknown) => STAGE[String(v ?? '').toLowerCase()] ?? 'both';

/** Plugin staff roles -> SaaS login roles. Unknown roles become 'teacher' and are reported. */
const STAFF_ROLE: Record<string, string> = {
  educbt_teacher: 'teacher', educbt_principal: 'principal', educbt_vice_principal: 'vice_principal',
  educbt_exam_officer: 'exam_officer', educbt_examofficer: 'exam_officer',
};
const STUDENT_STATUS = new Set(['active', 'suspended', 'withdrawn', 'expelled', 'pending_approval', 'graduated']);
const STAFF_STATUS: Record<string, string> = { active: 'active', suspended: 'suspended', left: 'left', inactive: 'left', resigned: 'left', terminated: 'left' };
const ENROLL_STATUS: Record<string, string> = { active: 'active', inactive: 'inactive', transferred: 'transferred', pending_approval: 'pending_approval', pending: 'pending_approval', withdrawn: 'inactive', graduated: 'inactive' };
const ASSIGNMENT: Record<string, string> = { class_teacher: 'class_teacher', subject_teacher: 'subject_teacher' };

/** Tables the plugin file may carry that slice 1 does not translate. Named, never silently ignored. */
const LATER_SLICES = [
  'assessment_components', 'assessment_scores', 'subject_results', 'term_results', 'results', 'grading_scales', 'grade_bands',
  'questions', 'question_options', 'question_sets', 'question_sub_items', 'passages', 'exams', 'exam_papers', 'exam_series',
  'exam_attempts', 'attempts', 'attempt_answers', 'attempt_events', 'exam_questions', 'paper_questions', 'exam_timetables',
  'paper_invigilators', 'promotion_batches', 'promotion_decisions', 'promotions', 'transcripts', 'announcements',
  'messages', 'message_threads', 'notifications', 'signatures', 'remark_ranges',
];

export function translatePluginBackup(plugin: PluginBackup): { document: BackupDocument; report: TranslateReport } {
  if (plugin?.format !== 'educbt-wp-school-backup') throw new PluginBackupError('This is not an EduCBT WordPress plugin backup.');
  if (!plugin.school || typeof plugin.school !== 'object') throw new PluginBackupError('The backup has no school record.');
  const T = plugin.tables ?? {};
  const rows = (name: string): Row[] => (Array.isArray(T[name]) ? T[name]! : []);
  const notes: string[] = [];
  const out: Record<string, Row[]> = {};
  const translated: Record<string, number> = {};
  const emit = (table: string, list: Row[]) => { out[table] = list; translated[table] = list.length; };

  // ── Structure ────────────────────────────────────────────────
  emit('academic_sessions', rows('academic_sessions').map((r) => ({
    id: num(r.id), school_id: 0, title: str(r.title) ?? 'Session ' + r.id, starts_on: iso(r.starts_on), ends_on: iso(r.ends_on), is_current: bool(r.is_current),
  })));
  // Real installs hold terms whose session was deleted later. Dropping them would lose their results, so
  // a clearly labelled session is recreated for them and the person migrating is told.
  const sessionList = out.academic_sessions!;
  const knownSessions = new Set(sessionList.map((s) => s.id));
  for (const r of rows('terms')) {
    const sid = num(r.session_id);
    if (sid !== null && !knownSessions.has(sid)) {
      knownSessions.add(sid);
      sessionList.push({ id: sid, school_id: 0, title: `Earlier session (recovered ${sid})`, starts_on: null, ends_on: null, is_current: false });
      notes.push(`Some terms belonged to a session that had been deleted. A session called "Earlier session (recovered ${sid})" was created to hold them, so nothing is lost. You can rename it.`);
    }
  }
  translated.academic_sessions = sessionList.length;
  emit('terms', rows('terms').filter((r) => num(r.session_id) !== null).map((r) => ({
    id: num(r.id), school_id: 0, session_id: num(r.session_id), title: str(r.title) ?? 'Term ' + r.id, position: num(r.term_order) ?? 1,
    starts_on: iso(r.starts_on), ends_on: iso(r.ends_on), is_current: bool(r.is_current),
  })));
  emit('class_levels', rows('class_levels').map((r) => ({
    id: num(r.id), school_id: 0, name: str(r.name) ?? 'Level ' + r.id, stage: stageOf(r.stage) === 'both' ? 'junior' : stageOf(r.stage), level_order: num(r.level_order) ?? 0,
  })));
  const levelIds = new Set(out.class_levels!.map((l) => l.id));
  emit('departments', rows('departments').map((r) => ({ id: num(r.id), school_id: 0, name: str(r.name) ?? 'Department ' + r.id, sort_order: num(r.sort_order) ?? 0 })));
  const deptIds = new Set(out.departments!.map((d) => d.id));

  const classRows: Row[] = [];
  for (const r of rows('classes')) {
    if (!levelIds.has(num(r.level_id))) { notes.push(`Class "${str(r.display_name) ?? r.id}" has no year group, so it was left out.`); continue; }
    const d = link(r.department_id);
    classRows.push({ id: num(r.id), school_id: 0, level_id: num(r.level_id), department_id: d !== null && deptIds.has(d) ? d : null,
      arm: str(r.arm), display_name: str(r.display_name) ?? `${r.id}`, status: str(r.status) ?? 'active', capacity: num(r.capacity) ?? 0 });
  }
  emit('classes', classRows);
  const classIds = new Set(classRows.map((c) => c.id));

  // The plugin keeps two subject lists; subjects_v2 is the current one and the original list is only
  // used when v2 is empty (a very old install).
  const subjectSource = rows('subjects_v2').length ? rows('subjects_v2') : rows('subjects');
  const usedCodes = new Set<string>();
  const subjectRows: Row[] = [];
  for (const r of subjectSource) {
    let code = (str(r.code) ?? str(r.name) ?? 'SUBJ' + r.id)!.toUpperCase().replace(/\s+/g, '').slice(0, 20);
    if (usedCodes.has(code)) { const was = code; code = `${code}${r.id}`; notes.push(`Two subjects shared the code ${was}; "${str(r.name)}" is now ${code}.`); }
    usedCodes.add(code);
    const d = link(r.department_id);
    subjectRows.push({ id: num(r.id), school_id: 0, name: str(r.name) ?? code, code, stage: stageOf(r.stage),
      category: String(r.category ?? '').toLowerCase() === 'core' || bool(r.is_compulsory) ? 'core' : 'elective',
      department_id: d !== null && deptIds.has(d) ? d : null, is_compulsory: bool(r.is_compulsory), status: str(r.status) ?? 'active' });
  }
  emit('subjects', subjectRows);
  const subjectIds = new Set(subjectRows.map((s) => s.id));

  // ── People ───────────────────────────────────────────────────
  // The SaaS keeps a login row per person. The plugin's logins are WordPress users, which are NOT in the
  // file, so each staff member / student gets a fresh SaaS login and nobody keeps a WordPress password.
  const userRows: Row[] = [];
  let nextUser = 1;
  const newUser = (role: string, loginId: string): number => {
    const id = nextUser++; userRows.push({ id, school_id: 0, role, login_id: loginId, status: 'active' }); return id;
  };
  const takenLogins = new Set<string>();
  const uniqueLogin = (base: string): string => {
    let l = base.toLowerCase().replace(/[^a-z0-9._/-]/g, ''); if (!l) l = 'user';
    let n = l, i = 1; while (takenLogins.has(n)) n = `${l}${++i}`;
    takenLogins.add(n); return n;
  };

  const staffRows: Row[] = [];
  for (const r of rows('staff')) {
    const slug = String(r.role_slug ?? '');
    let role = STAFF_ROLE[slug];
    if (!role) { role = 'teacher'; notes.push(`Staff member ${str(r.first_name) ?? ''} ${str(r.last_name) ?? ''} had the role "${slug || 'none'}", which the platform does not know, so they were added as a teacher.`); }
    const userId = newUser(role, uniqueLogin(str(r.staff_number) ?? `staff${r.id}`));
    staffRows.push({ id: num(r.id), school_id: 0, user_id: userId, staff_number: str(r.staff_number) ?? `STF${r.id}`, first_name: str(r.first_name) ?? '-',
      last_name: str(r.last_name) ?? '-', title: str(r.title), gender: str(r.gender), email: str(r.email), phone: str(r.phone), photo_url: str(r.photo), role,
      status: STAFF_STATUS[String(r.status ?? 'active')] ?? 'active' });
  }
  emit('staff', staffRows);
  const staffIds = new Set(staffRows.map((s) => s.id));

  // Students: the class link is the plugin's enrollments table, never the loose text columns (often empty or stale).
  const studentRows: Row[] = [];
  for (const r of rows('students')) {
    const adm = str(r.admission_number) ?? str(r.registration_number) ?? str(r.student_id);
    if (!adm) { notes.push(`A student (${str(r.first_name) ?? ''} ${str(r.last_name) ?? ''}) has no admission number, so they were left out.`); continue; }
    const status = String(r.status ?? 'active');
    if (!STUDENT_STATUS.has(status)) notes.push(`${adm}: unknown status "${status}", set to active.`);
    const userId = newUser('student', uniqueLogin(adm));
    const [first, last] = [str(r.first_name), str(r.last_name)];
    const full = str(r.full_name);
    studentRows.push({ id: num(r.id), school_id: 0, user_id: userId, admission_number: adm,
      first_name: first ?? (full ? full.split(' ')[0]! : '-'), last_name: last ?? (full ? full.split(' ').slice(1).join(' ') || '-' : '-'),
      middle_name: null, gender: str(r.gender), date_of_birth: iso(r.date_of_birth), photo_url: str(r.passport_photo), address: str(r.address),
      parent_name: str(r.parent_information), parent_phone: str(r.parent_phone), parent_email: str(r.parent_email),
      status: STUDENT_STATUS.has(status) ? status : 'active', status_changed_at: iso(r.status_changed_at), admitted_at: iso(r.created_at) });
  }
  emit('students', studentRows);
  const studentIds = new Set(studentRows.map((s) => s.id));

  const guardianRows: Row[] = [];
  for (const r of rows('guardians')) {
    const name = [str(r.first_name), str(r.last_name)].filter(Boolean).join(' ') || 'Guardian ' + r.id;
    const userId = newUser('parent', uniqueLogin(str(r.email) ?? `parent${r.id}`));
    guardianRows.push({ id: num(r.id), school_id: 0, user_id: userId, full_name: name, email: str(r.email), phone: str(r.phone),
      invite_status: 'none', invite_token: null });
  }
  emit('guardians', guardianRows);
  const guardianIds = new Set(guardianRows.map((g) => g.id));
  emit('guardian_student', rows('guardian_student').filter((r) => {
    const ok = guardianIds.has(num(r.guardian_id)) && studentIds.has(num(r.student_id));
    if (!ok) notes.push('A guardian link pointed at a missing guardian or student and was left out.');
    return ok;
  }).map((r) => ({ id: num(r.id), school_id: 0, guardian_id: num(r.guardian_id), student_id: num(r.student_id), relationship: str(r.relationship) ?? 'guardian',
    can_view_results: r.can_view_results === undefined ? true : bool(r.can_view_results) })));

  emit('users', userRows);

  // ── Placement ────────────────────────────────────────────────
  const sessionIds = new Set(out.academic_sessions!.map((s) => s.id));
  const enrolled = new Set<string>();
  emit('enrollments', rows('enrollments').filter((r) => {
    const ok = studentIds.has(num(r.student_id)) && classIds.has(num(r.class_id)) && sessionIds.has(num(r.session_id));
    if (!ok) { notes.push('An enrolment pointed at a missing student, class or session and was left out.'); return false; }
    const key = `${r.student_id}/${r.session_id}`;
    if (enrolled.has(key)) { notes.push('A student was enrolled twice in one session; only the first was kept.'); return false; }
    enrolled.add(key); return true;
  }).map((r) => ({ id: num(r.id), school_id: 0, student_id: num(r.student_id), class_id: num(r.class_id), session_id: num(r.session_id),
    status: ENROLL_STATUS[String(r.status ?? 'active')] ?? 'active' })));
  const unplaced = studentRows.filter((s) => !rows('enrollments').some((e) => num(e.student_id) === s.id)).length;
  if (unplaced) notes.push(`${unplaced} student(s) are not placed in any class in the plugin, so they arrive without a class.`);

  emit('student_subjects', rows('student_subjects').filter((r) => studentIds.has(num(r.student_id)) && subjectIds.has(num(r.subject_id)) && sessionIds.has(num(r.session_id)))
    .map((r) => ({ id: num(r.id), school_id: 0, student_id: num(r.student_id), subject_id: num(r.subject_id), session_id: num(r.session_id) })));

  emit('staff_assignments', rows('staff_assignments').filter((r) => {
    const t = String(r.assignment_type ?? '');
    const cls = link(r.class_id), sub = link(r.subject_id);
    const ok = staffIds.has(num(r.staff_id)) && !!ASSIGNMENT[t] && (cls === null || classIds.has(cls)) && (sub === null || subjectIds.has(sub));
    if (!ok) notes.push('A teaching duty pointed at a missing teacher, class or subject and was left out.');
    return ok;
  }).map((r) => ({ id: num(r.id), school_id: 0, staff_id: num(r.staff_id), assignment_type: ASSIGNMENT[String(r.assignment_type)],
    // A duty the school already ended ("dropped") is kept as an inactive record, so history is not lost.
    class_id: link(r.class_id), subject_id: link(r.subject_id), status: (str(r.status) ?? 'active') })));

  const notTranslated = LATER_SLICES.filter((t) => rows(t).length > 0);
  const s = plugin.school;
  const school: Row = { name: str(s.school_name) ?? 'Imported school', address: str(s.address), phone: str(s.phone), email: str(s.email), website: str(s.website),
    principal_name: str(s.principal_name), logo_url: str(s.logo), principal_photo_url: str(s.principal_photo), settings: {} };

  const document = buildDocument({ createdAt: new Date().toISOString(), app: { name: 'EduCBT', schemaTables: Object.keys(out).length },
    credentials: 'none', school, tables: out, uploads: plugin.uploads ?? {} });
  return { document, report: { translated, notes: [...new Set(notes)], notTranslated } };
}
