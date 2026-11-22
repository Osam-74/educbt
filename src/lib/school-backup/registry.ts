/**
 * The school backup registry. EVERY table in the schema is classified here, on purpose.
 *
 *   data       copied into the backup and recreated for the new school
 *   excluded   deliberately NOT copied (credentials, live sessions, queues), with the reason
 *   platform   not owned by a school at all
 *
 * A test (test-school-backup-registry) compares this list with the real database and
 * fails when a table exists that is not classified here. That is what keeps
 * "everything is backed up" true as the product grows: a new table cannot ship until
 * someone decides how it is backed up.
 *
 * The order of DATA_TABLES is a valid insert order: every table appears after all the
 * tables it references, so a restore can insert in this order without deferring
 * constraints. test-school-backup-registry checks that too, against the real foreign keys.
 */

/** How one column is treated when a row is copied out of, or back into, a school. */
export type ColumnRule =
  /** this column is the row's own primary key: replaced by a new id on restore */
  | { kind: 'pk' }
  /** the school the row belongs to: always the NEW school on restore */
  | { kind: 'school' }
  /** points at a row in another backed-up table: remapped through that table's id map */
  | { kind: 'ref'; table: string; nullable?: boolean }
  /** a "/api/photos/{token}" path: the upload is copied under a new token and the path rewritten */
  | { kind: 'photo' }
  /** never written to the file; restored as `value` */
  | { kind: 'strip'; value: unknown };

export type TableSpec = {
  table: string;
  /** SQL column name -> rule. Columns not listed are copied verbatim. */
  columns: Record<string, ColumnRule>;
  /** why this table exists in the backup, shown in the manifest */
  about: string;
};

const pk: ColumnRule = { kind: 'pk' };
const school: ColumnRule = { kind: 'school' };
const ref = (table: string, nullable = false): ColumnRule => ({ kind: 'ref', table, nullable });

/** Insert order. Parents first. Column names come from the real schema; the registry test checks them. */
export const DATA_TABLES: TableSpec[] = [
  // ── Structure ─────────────────────────────────────────────────────────────
  { table: 'academic_sessions', about: 'Academic sessions', columns: { id: pk, school_id: school } },
  { table: 'terms', about: 'Terms of each session', columns: { id: pk, school_id: school, session_id: ref('academic_sessions') } },
  { table: 'class_levels', about: 'Year groups (JSS 1, SS 2, ...)', columns: { id: pk, school_id: school } },
  { table: 'departments', about: 'Senior school departments', columns: { id: pk, school_id: school } },
  { table: 'classes', about: 'Class arms', columns: { id: pk, school_id: school, level_id: ref('class_levels'), department_id: ref('departments', true) } },
  { table: 'subjects', about: 'Subjects', columns: { id: pk, school_id: school, department_id: ref('departments', true) } },

  // ── People ────────────────────────────────────────────────────────────────
  // Logins are recreated WITHOUT credentials. See USER_STRIP below.
  { table: 'users', about: 'Logins (no passwords or two-factor secrets)', columns: { id: pk, school_id: school } },
  { table: 'user_login_aliases', about: 'Old sign-in names that still work (from the WordPress plugin)', columns: { id: pk, school_id: school, user_id: ref('users') } },
  { table: 'staff', about: 'Teachers and office staff', columns: { id: pk, school_id: school, user_id: ref('users', true), photo_url: { kind: 'photo' } } },
  { table: 'staff_assignments', about: 'Who teaches what, and class teacher duties',
    columns: { id: pk, school_id: school, staff_id: ref('staff'), subject_id: ref('subjects', true), class_id: ref('classes', true) } },
  { table: 'students', about: 'Students', columns: { id: pk, school_id: school, user_id: ref('users', true), photo_url: { kind: 'photo' } } },
  { table: 'enrollments', about: 'Which class each student is in, per session',
    columns: { id: pk, school_id: school, student_id: ref('students'), class_id: ref('classes'), session_id: ref('academic_sessions') } },
  { table: 'student_subjects', about: 'Subjects each student registered for',
    columns: { id: pk, school_id: school, student_id: ref('students'), subject_id: ref('subjects'), session_id: ref('academic_sessions') } },
  // invite_token is a live sign-up credential; the invite is reset on restore.
  { table: 'guardians', about: 'Parents and guardians',
    columns: { id: pk, school_id: school, user_id: ref('users', true), invite_token: { kind: 'strip', value: null } } },
  { table: 'guardian_student', about: 'Which guardian belongs to which student',
    columns: { id: pk, school_id: school, guardian_id: ref('guardians'), student_id: ref('students') } },

  // ── Files ─────────────────────────────────────────────────────────────────
  { table: 'portal_uploads', about: 'Uploaded photos (stored in the database)', columns: { id: pk, school_id: school, token: { kind: 'strip', value: '__new_token__' } } },
  { table: 'staff_signatures', about: 'Signatures printed on report cards', columns: { id: pk, school_id: school, staff_id: ref('staff') } },
  { table: 'staff_remark_ranges', about: 'Report remark ranges set by staff', columns: { id: pk, school_id: school, staff_id: ref('staff') } },
  { table: 'school_remark_ranges', about: 'Report remark ranges shared by the whole school', columns: { id: pk, school_id: school } },

  // ── Exams and questions ───────────────────────────────────────────────────
  { table: 'exam_series', about: 'CA tests and examination series',
    columns: { id: pk, school_id: school, session_id: ref('academic_sessions'), term_id: ref('terms', true), created_by: ref('users', true) } },
  { table: 'question_sets', about: 'Question sets submitted by teachers',
    columns: { id: pk, school_id: school, session_id: ref('academic_sessions', true), term_id: ref('terms', true), subject_id: ref('subjects'),
      level_id: ref('class_levels', true), department_id: ref('departments', true), class_id: ref('classes', true),
      series_id: ref('exam_series', true), teacher_id: ref('staff', true), submitted_by: ref('users', true), reviewed_by: ref('users', true) } },
  { table: 'passages', about: 'Comprehension passages', columns: { id: pk, school_id: school, subject_id: ref('subjects', true), author_staff_id: ref('staff', true) } },
  // parent_id points at another question: it is remapped in a second pass (see restore).
  { table: 'questions', about: 'Questions',
    columns: { id: pk, school_id: school, question_set_id: ref('question_sets'), passage_id: ref('passages', true), parent_id: ref('questions', true), reviewed_by: ref('users', true) } },
  { table: 'question_options', about: 'Answer options', columns: { id: pk, school_id: school, question_id: ref('questions') } },
  { table: 'question_parts', about: 'Labelled parts of theory questions', columns: { id: pk, school_id: school, question_id: ref('questions') } },
  { table: 'bank_questions', about: 'The standalone question bank (topic, difficulty, exam year, marking guide)',
    columns: { id: pk, school_id: school, subject_id: ref('subjects', true), author_staff_id: ref('staff', true), reviewed_by: ref('users', true), parent_id: ref('bank_questions', true), image_url: { kind: 'photo' } } },
  { table: 'bank_question_options', about: 'Answer options of bank questions', columns: { id: pk, school_id: school, question_id: ref('bank_questions'), image_url: { kind: 'photo' } } },
  { table: 'bank_question_parts', about: 'Labelled parts of theory bank questions', columns: { id: pk, school_id: school, question_id: ref('bank_questions') } },
  { table: 'legacy_exam_papers', about: 'Exam papers from the WordPress plugin (read-only history)',
    columns: { id: pk, school_id: school, subject_id: ref('subjects', true), class_id: ref('classes', true), session_id: ref('academic_sessions', true), term_id: ref('terms', true) } },
  { table: 'legacy_exam_attempts', about: 'Student exam sittings from the WordPress plugin (read-only history)',
    columns: { id: pk, school_id: school, paper_id: ref('legacy_exam_papers', true), student_id: ref('students', true) } },
  { table: 'legacy_attempt_answers', about: 'Answers of those sittings, with the question as it was', columns: { id: pk, school_id: school, attempt_id: ref('legacy_exam_attempts') } },
  { table: 'legacy_attempt_events', about: 'Integrity log of those sittings', columns: { id: pk, school_id: school, attempt_id: ref('legacy_exam_attempts') } },
  { table: 'question_vault', about: 'Safety copies of question sets', columns: { id: pk, school_id: school, question_set_id: ref('question_sets', true) } },
  { table: 'exam_papers', about: 'Scheduled exam papers',
    columns: { id: pk, school_id: school, series_id: ref('exam_series', true), subject_id: ref('subjects'), level_id: ref('class_levels', true),
      department_id: ref('departments', true), class_id: ref('classes', true), invigilator_staff_id: ref('staff', true), code_released_by: ref('users', true) } },
  { table: 'paper_questions', about: 'Which questions are on which paper',
    columns: { id: pk, school_id: school, paper_id: ref('exam_papers'), question_id: ref('questions') } },

  // ── Sittings and results ──────────────────────────────────────────────────
  { table: 'attempts', about: 'Student exam sittings', columns: { id: pk, school_id: school, paper_id: ref('exam_papers'), student_id: ref('students') } },
  { table: 'attempt_answers', about: 'Answers given in each sitting',
    columns: { id: pk, school_id: school, attempt_id: ref('attempts'), question_id: ref('questions'), option_id: ref('question_options', true), marked_by: ref('users', true) } },
  { table: 'attempt_events', about: 'Integrity events during sittings', columns: { id: pk, school_id: school, attempt_id: ref('attempts') } },
  { table: 'assessment_scores', about: 'Continuous assessment scores',
    columns: { id: pk, school_id: school, student_id: ref('students'), subject_id: ref('subjects'), session_id: ref('academic_sessions'), term_id: ref('terms'), entered_by: ref('users', true) } },
  { table: 'subject_results', about: 'Compiled results and broadsheet data',
    columns: { id: pk, school_id: school, student_id: ref('students'), subject_id: ref('subjects'), session_id: ref('academic_sessions'), term_id: ref('terms') } },
  { table: 'grading_scale_versions', about: 'Grading scales as they were used', columns: { id: pk, school_id: school } },
  { table: 'report_remarks', about: 'Remarks on report cards',
    columns: { id: pk, school_id: school, student_id: ref('students'), session_id: ref('academic_sessions'), term_id: ref('terms'), staff_id: ref('staff', true) } },
  { table: 'term_summaries', about: 'Term remarks, attendance and approval for each student',
    columns: { id: pk, school_id: school, student_id: ref('students'), session_id: ref('academic_sessions'), term_id: ref('terms'), class_id: ref('classes', true),
      submitted_by: ref('users', true), approved_by: ref('users', true) } },
  { table: 'promotion_batches', about: 'Promotion runs',
    columns: { id: pk, school_id: school, from_session_id: ref('academic_sessions'), to_session_id: ref('academic_sessions'), level_id: ref('class_levels'),
      created_by: ref('users', true), committed_by: ref('users', true), reversed_by: ref('users', true) } },
  { table: 'promotion_decisions', about: 'Promotion decision for each student',
    columns: { id: pk, school_id: school, batch_id: ref('promotion_batches'), student_id: ref('students'),
      from_class_id: ref('classes', true), to_class_id: ref('classes', true), overridden_by: ref('users', true) } },

  // ── Communication ─────────────────────────────────────────────────────────
  // audience_ref points at a class, level or department depending on `audience`: remapped by that value.
  { table: 'announcements', about: 'Announcements', columns: { id: pk, school_id: school, author_user_id: ref('users', true) } },
  { table: 'message_threads', about: 'Message threads', columns: { id: pk, school_id: school, created_by: ref('users', true) } },
  { table: 'thread_participants', about: 'Who is in each thread', columns: { school_id: school, thread_id: ref('message_threads'), user_id: ref('users') } },
  { table: 'messages', about: 'Messages', columns: { id: pk, school_id: school, thread_id: ref('message_threads'), sender_user_id: ref('users', true) } },
  { table: 'notifications', about: 'Notifications', columns: { id: pk, school_id: school, user_id: ref('users') } },
  { table: 'notification_prefs', about: 'Notification preferences', columns: { school_id: school, user_id: ref('users') } },

  // ── History ───────────────────────────────────────────────────────────────
  // entity_id points at many kinds of row under inconsistent names, so it is cleared on restore
  // (a wrong link is worse than none). The readable before/after of every entry is kept.
  { table: 'audit_log', about: 'Activity log', columns: { id: pk, school_id: school, actor_user_id: ref('users', true), entity_id: { kind: 'strip', value: null } } },
];

/** The school's own row. Restored by creating a NEW school, never by overwriting one. */
export const SCHOOL_TABLE = 'schools';

/** Not copied, on purpose. The reason is part of the contract and is shown to the operator. */
export const EXCLUDED_TABLES: Record<string, string> = {
  sessions: 'Live login sessions. Anyone holding one is signed in; a backup must never carry them.',
  password_reset_tokens: 'Unused password-reset links are credentials.',
  totp_recovery_codes: 'Two-factor recovery codes are credentials.',
  email_events: 'The outgoing email queue is transient; restoring it could re-send old emails to real parents.',
  school_document_templates: 'Print templates are assigned by the platform administrator, not by the school. A restore creates a NEW school, so it must not carry a platform-assigned design over from a file (a tampered backup could otherwise set one). A restored school prints with the platform default until the administrator assigns one.',
  transcripts: 'Each transcript has a globally unique public verification serial. Copying one would create a second "genuine" transcript with the same serial. Reissue them from the restored results.',
};

/** Not owned by any school. */
export const PLATFORM_TABLES: Record<string, string> = {
  platform_settings: 'Platform-wide branding, not part of any school.',
  school_backup_jobs: 'Platform-level restore progress. Has no school_id, and a backup must never contain other backups.',
  school_backup_chunks: 'Temporary pieces of an uploaded backup, deleted when the restore ends.',
};

/**
 * Columns on `users` that are never written to a backup.
 * password_hash and totp_secret are credentials. A restored user must set a new password
 * and re-enrol two-factor, so a leaked backup file can never sign anyone in.
 */
export const UNUSABLE_PASSWORD_PREFIX = '!restored-no-password!';

export const USER_STRIP: Record<string, unknown> = {
  // users.password_hash is NOT NULL, so a restored login carries an unusable placeholder (made unique
  // per user in remapRow). It is not a valid argon2 string, so verifyPassword() answers "wrong
  // password" for every input. The user cannot sign in until the office issues a password.
  password_hash: UNUSABLE_PASSWORD_PREFIX,
  totp_secret: null,
  totp_enabled: false,
  must_change_password: true,
  failed_attempts: 0,
  locked_until: null,
  last_login_at: null,
  email_verified_at: null,
};

/**
 * When a backup is taken WITH password hashes, these are the only users columns that change meaning:
 * the hash and the must-change flag are kept as they were. Everything else in USER_STRIP (two-factor
 * secret, lock-out state, last login, verified email) is still reset.
 */
export const USER_KEEP_WITH_PASSWORDS = ['password_hash', 'must_change_password'] as const;

/** A genuine Argon2id hash: the only password material a restore will ever accept from a file. */
export const ARGON2ID_HASH = /^\$argon2id\$v=\d+\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/;

/** Columns on `schools` that identify the OLD school and must not be carried into the new one. */
export const SCHOOL_STRIP = ['id', 'code', 'subdomain', 'custom_domain', 'id_prefix', 'status', 'created_at', 'updated_at'] as const;

export function allClassifiedTables(): string[] {
  return [
    SCHOOL_TABLE,
    ...DATA_TABLES.map((t) => t.table),
    ...Object.keys(EXCLUDED_TABLES),
    ...Object.keys(PLATFORM_TABLES),
  ];
}
