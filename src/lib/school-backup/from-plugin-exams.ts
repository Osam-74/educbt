/**
 * Plugin -> SaaS migration, slice 4: exam papers and student sittings, kept as read-only HISTORY.
 *
 * Why history and not live exams: a plugin paper draws from the standalone question bank, and a SaaS attempt can only
 * point at a set-based question. Re-creating them as live SaaS exams would mean inventing sets, series and papers the
 * school never made. So they are frozen: nothing the school recorded is lost, no live exam table is touched.
 *
 * Every row keeps the queryable facts as real columns AND the plugin's original row verbatim in `source`, so a
 * column this code does not know about (or one a later plugin version adds) is never lost.
 *
 * Every answer is frozen WITH the question wording, the option the student chose and the correct option as they were,
 * because the live bank can be edited afterwards and a result must keep reading the way the student saw it.
 *
 * The plugin keeps TWO exam systems and both are carried:
 *   'paper'  the newer one: exam_series, exam_papers, paper_questions, attempts, attempt_answers, attempt_events
 *   'legacy' the older one: exams, exam_questions, exam_attempts, results, exam_timetables, exam_integrity_events
 */
import type { PluginBackup } from './from-plugin';

type Row = Record<string, unknown>;
export type ExamSlice = { tables: Record<string, Row[]> };

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());
const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const link = (v: unknown): number | null => { const n = num(v); return n === null || n === 0 ? null : n; };
const iso = (v: unknown): string | null => {
  const s = str(v); if (!s || s.startsWith('0000')) return null;
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const bool = (v: unknown): boolean | null => (v === null || v === undefined || v === '' ? null : v === true || v === 1 || v === '1');
/**
 * Live secrets are never archived, whatever the file says. The exporter already blanks them; this is the second
 * lock, because a file can come from an older or another exporter, and an exam access code or a session token
 * kept in a read-only history would sit in every later backup of the school.
 */
const SECRET_KEYS = ['access_code', 'session_token', 'session_key', 'invite_token'];
const scrub = <T extends Record<string, unknown>>(row: T): T => {
  const out: Record<string, unknown> = { ...row };
  for (const k of SECRET_KEYS) if (k in out && out[k] !== null && out[k] !== '') out[k] = '';
  return out as T;
};
const jsonOr = <T>(v: unknown, fallback: T): T => {
  if (v === null || v === undefined || v === '') return fallback;
  if (typeof v === 'object') return v as T;
  try { return JSON.parse(String(v)) as T; } catch { return fallback; }
};

export function translateExams(
  plugin: PluginBackup,
  known: { subjects: Set<number>; classes: Set<number>; sessions: Set<number>; terms: Set<number>; students: Set<number>; subjectNames: Map<number, string>; classNames: Map<number, string> },
  report: { notes: string[] },
): ExamSlice {
  const T = plugin.tables ?? {};
  const rows = (n: string): Row[] => (Array.isArray(T[n]) ? T[n]! : []);
  const byId = (n: string) => new Map(rows(n).map((r) => [num(r.id), r]));

  const questions = byId('questions');
  const optionsOf = new Map<number, Row[]>();
  for (const o of rows('question_options')) { const q = num(o.question_id); if (q !== null) (optionsOf.get(q) ?? optionsOf.set(q, []).get(q)!).push(o); }
  const series = byId('exam_series');

  const papers: Row[] = [], attempts: Row[] = [], answers: Row[] = [], events: Row[] = [];
  const paperKey = (kind: string, id: unknown) => `${kind}/${num(id)}`;
  const paperIndex = new Map<string, number>();     // kind/sourceId -> position in `papers` (becomes the new id)
  let orphanAttempts = 0, unknownStudents = 0, answersWithoutQuestion = 0;

  // ── Papers from the newer system ───────────────────────────
  const invigilatorsOf = new Map<number, Row[]>();
  for (const iv of rows('paper_invigilators')) { const p = num(iv.paper_id); if (p !== null) (invigilatorsOf.get(p) ?? invigilatorsOf.set(p, []).get(p)!).push(iv); }
  const paperQuestionsOf = new Map<number, Row[]>();
  for (const pq of rows('paper_questions')) { const p = num(pq.paper_id); if (p !== null) (paperQuestionsOf.get(p) ?? paperQuestionsOf.set(p, []).get(p)!).push(pq); }

  for (const p of rows('exam_papers')) {
    const id = num(p.id); if (id === null) continue;
    const s = series.get(num(p.series_id));
    const subject = link(p.subject_id), klass = link(p.class_id);
    // The questions are frozen WITH their wording and options, as the paper held them.
    const frozen = (paperQuestionsOf.get(id) ?? []).slice().sort((a, b) => (num(a.sort_order) ?? 0) - (num(b.sort_order) ?? 0)).map((pq) => {
      const qid = num(pq.question_id); const q = qid === null ? undefined : questions.get(qid);
      return { question_id: qid, marks: num(pq.marks), text: q ? str(q.question_text) : '', type: q ? str(q.question_type) : '',
        options: (qid === null ? [] : optionsOf.get(qid) ?? []).slice().sort((a, b) => (num(a.sort_order) ?? 0) - (num(b.sort_order) ?? 0))
          .map((o) => ({ key: str(o.option_key), text: str(o.option_text), correct: bool(o.is_correct) === true })) };
    });
    papers.push({ id: papers.length + 1, school_id: 0, kind: 'paper', source_id: id, series_source_id: link(p.series_id),
      title: s ? str(s.title) : '', series_type: s ? str(s.series_type) : '',
      subject_id: subject !== null && known.subjects.has(subject) ? subject : null, subject_name: subject !== null ? known.subjectNames.get(subject) ?? '' : '',
      class_id: klass !== null && known.classes.has(klass) ? klass : null, class_name: klass !== null ? known.classNames.get(klass) ?? '' : '',
      session_id: s && known.sessions.has(num(s.session_id) ?? -1) ? num(s.session_id) : null, term_id: s && known.terms.has(num(s.term_id) ?? -1) ? num(s.term_id) : null,
      status: str(p.status), scheduled_at: iso(p.scheduled_at), duration_seconds: num(p.duration_seconds) ?? 0, question_count: num(p.question_count) ?? 0,
      total_marks: num(p.total_marks) ?? 0, source: { ...scrub(p), series: s ? scrub(s) : null, invigilators: invigilatorsOf.get(id) ?? [] }, questions: frozen, created_at: iso(p.created_at) });
    paperIndex.set(paperKey('paper', id), papers.length);
  }

  // A series with no paper (an empty draft) is still the school's record: kept as a paper-less entry.
  const seriesWithPaper = new Set(rows('exam_papers').map((p) => num(p.series_id)));
  for (const s of rows('exam_series')) {
    const id = num(s.id); if (id === null || seriesWithPaper.has(id)) continue;
    papers.push({ id: papers.length + 1, school_id: 0, kind: 'series', source_id: id, series_source_id: id, title: str(s.title), series_type: str(s.series_type),
      subject_id: null, subject_name: '', class_id: null, class_name: '',
      session_id: known.sessions.has(num(s.session_id) ?? -1) ? num(s.session_id) : null, term_id: known.terms.has(num(s.term_id) ?? -1) ? num(s.term_id) : null,
      status: str(s.status), scheduled_at: iso(s.starts_on), duration_seconds: (num(s.duration_minutes) ?? 0) * 60, question_count: num(s.questions_per_student) ?? 0,
      total_marks: 0, source: { ...scrub(s) }, questions: [], created_at: iso(s.created_at) });
    paperIndex.set(paperKey('series', id), papers.length);
  }

  // ── Papers from the older system ───────────────────────────
  const examQuestionsOf = new Map<number, Row[]>();
  for (const eq of rows('exam_questions')) { const e = num(eq.exam_id); if (e !== null) (examQuestionsOf.get(e) ?? examQuestionsOf.set(e, []).get(e)!).push(eq); }
  const timetableOf = new Map<number, Row>();
  for (const t of rows('exam_timetables')) { const e = num(t.exam_id); if (e !== null) timetableOf.set(e, t); }
  for (const e of rows('exams')) {
    const id = num(e.id); if (id === null) continue;
    const tt = timetableOf.get(id);
    const frozen = (examQuestionsOf.get(id) ?? []).map((eq) => {
      const qid = num(eq.question_id); const q = qid === null ? undefined : questions.get(qid);
      return { question_id: qid, marks: q ? num(q.marks) : null, text: q ? str(q.question_text) : '', type: q ? str(q.question_type) : '',
        options: (qid === null ? [] : optionsOf.get(qid) ?? []).map((o) => ({ key: str(o.option_key), text: str(o.option_text), correct: bool(o.is_correct) === true })) };
    });
    papers.push({ id: papers.length + 1, school_id: 0, kind: 'legacy', source_id: id, series_source_id: null, title: str(e.title), series_type: str(e.exam_type),
      subject_id: null, subject_name: tt ? str(tt.subject) : '', class_id: null, class_name: tt ? [str(tt.class_name), str(tt.arm)].filter(Boolean).join(' ') : '',
      session_id: null, term_id: null, status: bool(e.is_published) ? 'published' : 'draft', scheduled_at: iso(e.start_time),
      duration_seconds: (num(e.duration_minutes) ?? 0) * 60, question_count: frozen.length, total_marks: 0,
      source: { ...scrub(e), timetable: tt ?? null }, questions: frozen, created_at: iso(e.created_at) });
    paperIndex.set(paperKey('legacy', id), papers.length);
  }

  // ── Sittings ───────────────────────────────────────────────
  const answersOf = new Map<number, Row[]>();
  for (const a of rows('attempt_answers')) { const k = num(a.attempt_id); if (k !== null) (answersOf.get(k) ?? answersOf.set(k, []).get(k)!).push(a); }
  const eventsOf = new Map<number, Row[]>();
  for (const ev of rows('attempt_events')) { const k = num(ev.attempt_id); if (k !== null) (eventsOf.get(k) ?? eventsOf.set(k, []).get(k)!).push(ev); }
  const integrityOf = new Map<number, Row[]>();
  for (const ev of rows('exam_integrity_events')) { const k = num(ev.attempt_id); if (k !== null) (integrityOf.get(k) ?? integrityOf.set(k, []).get(k)!).push(ev); }

  const freeze = (kind: 'paper' | 'legacy', a: Row, paperId: number | null, order: unknown[], eventRows: Row[], startedAt: unknown, submittedAt: unknown, extra: Row) => {
    const id = num(a.id)!;
    const stu = link(a.student_id);
    if (stu !== null && !known.students.has(stu)) unknownStudents++;
    attempts.push({ id: attempts.length + 1, school_id: 0, kind, source_id: id, paper_id: paperId, student_id: stu !== null && known.students.has(stu) ? stu : null,
      status: str(a.status), submit_reason: str(a.submit_reason), started_at: iso(startedAt), submitted_at: iso(submittedAt), graded_at: iso(a.graded_at),
      extension_seconds: num(a.extension_seconds) ?? 0, raw_score: num(extra.raw_score), max_score: num(extra.max_score), percentage: num(extra.percentage),
      flag_count: num(a.flag_count) ?? 0, integrity_count: num(a.integrity_count) ?? eventRows.length, question_order: order, source: { ...scrub(a) } });
    const newAttempt = attempts.length;
    for (const ev of eventRows) events.push({ id: events.length + 1, school_id: 0, attempt_id: newAttempt, event_type: str(ev.event_type),
      occurred_at: iso(ev.created_at), payload: jsonOr<Record<string, unknown>>(ev.payload ?? ev.event_payload, { raw: str(ev.payload ?? ev.event_payload) }) });
    return newAttempt;
  };

  for (const a of rows('attempts')) {
    const id = num(a.id); if (id === null) continue;
    const pIdx = paperIndex.get(paperKey('paper', a.paper_id));
    if (pIdx === undefined) orphanAttempts++;
    const order = jsonOr<unknown[]>(a.question_order, []);
    const newId = freeze('paper', a, pIdx ?? null, order, eventsOf.get(id) ?? [], a.started_at, a.submitted_at, { raw_score: a.raw_score, max_score: a.max_score, percentage: a.percentage });
    const paper = pIdx === undefined ? undefined : papers[pIdx - 1];
    const marksOf = new Map<number, number | null>(((paper?.questions as Array<{ question_id: number | null; marks: number | null }> | undefined) ?? []).map((q) => [q.question_id ?? -1, q.marks]));
    const answered = new Map((answersOf.get(id) ?? []).map((x) => [num(x.question_id), x]));
    // Frozen in the order the student SAW the questions, including the ones never answered.
    const seen = order.length ? order.map((q) => num(q)) : [...answered.keys()];
    seen.forEach((qid, i) => {
      const q = qid === null ? undefined : questions.get(qid); const ans = qid === null ? undefined : answered.get(qid);
      if (qid !== null && !q) answersWithoutQuestion++;
      const opts = qid === null ? [] : optionsOf.get(qid) ?? [];
      const chosen = ans ? opts.find((o) => num(o.id) === num(ans.option_id)) : undefined;
      const correct = opts.filter((o) => bool(o.is_correct) === true).map((o) => str(o.option_text)).join('; ');
      answers.push({ id: answers.length + 1, school_id: 0, attempt_id: newId, position: i, question_source_id: qid, question_text: q ? str(q.question_text) : '',
        chosen_option: chosen ? str(chosen.option_text) : null, correct_option: correct || null, answer_text: ans && str(ans.answer_text) ? str(ans.answer_text) : null,
        is_correct: ans ? bool(ans.is_correct) : null, marks_awarded: ans ? num(ans.marks_awarded) : null, marks_available: marksOf.get(qid ?? -1) ?? (q ? num(q.marks) : null),
        answered_at: ans ? iso(ans.answered_at) : null, source: ans ? { ...ans } : { unanswered: true, question_id: qid } });
    });
  }

  for (const a of rows('exam_attempts')) {
    const id = num(a.id); if (id === null) continue;
    const pIdx = paperIndex.get(paperKey('legacy', a.exam_id));
    if (pIdx === undefined) orphanAttempts++;
    const result = rows('results').find((r) => num(r.exam_attempt_id) === id);
    freeze('legacy', a, pIdx ?? null, jsonOr<unknown[]>(a.question_order, []), integrityOf.get(id) ?? [], a.time_started, a.time_submitted,
      { raw_score: result?.score, max_score: null, percentage: null });
    attempts[attempts.length - 1]!.source = { ...scrub(a), result: result ?? null };
  }

  if (orphanAttempts) report.notes.push(`${orphanAttempts} exam sitting(s) pointed at a paper that is not in the file. They were kept, without a paper.`);
  if (unknownStudents) report.notes.push(`${unknownStudents} exam sitting(s) belonged to a student who is not in the file. They were kept, without a student.`);
  if (answersWithoutQuestion) report.notes.push(`${answersWithoutQuestion} answer(s) were for a question that is no longer in the bank. The answer was kept; the question wording could not be.`);

  return { tables: { legacy_exam_papers: papers, legacy_exam_attempts: attempts, legacy_attempt_answers: answers, legacy_attempt_events: events } };
}
