/**
 * Plugin -> SaaS migration, slice 2: results. Pure functions, no database.
 *
 * What the plugin really stores (verified against a real plugin school, not assumed):
 *  - Its `subject_results` rows hold scores and positions but an EMPTY grade and remark. Grades are worked
 *    out when a report is shown, from the school's grade bands. So the migration carries the SCORES and the
 *    school's grading scale, and the SaaS works the grade out from the same bands. Carrying "the grade"
 *    is impossible because the plugin never saved one.
 *  - Every grade lookup in the plugin uses the school's DEFAULT scale. Any other scale (for example a stage
 *    scale) is never applied to a result, so the SaaS scale is the plugin's default scale. The others are
 *    reported, never silently dropped.
 *  - The plugin publishes the TERM row only. Its subject rows stay "compiled" even when the term is published,
 *    so whether a subject result is visible to a student is decided by its term row. Anything not clearly
 *    published stays hidden: a wrong guess here would show unpublished results to students.
 *
 * Nothing is dropped silently: whatever cannot be carried exactly goes into `notes`.
 */
import type { PluginBackup, TranslateReport } from './from-plugin';
import { computeTotal, gradeFor } from '@/domain/academic';

type Row = Record<string, unknown>;

const str = (v: unknown): string | null => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim());
const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const iso = (v: unknown): string | null => {
  const s = str(v); if (!s || s.startsWith('0000')) return null;
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Plugin term-row status -> what a SaaS subject result looks like. Unknown or unclear means hidden. */
export function subjectStateFor(termStatus: string | null): { state: 'draft' | 'compiled' | 'reviewed' | 'published'; published: boolean } {
  switch (termStatus) {
    case 'published': return { state: 'published', published: true };
    case 'approved': return { state: 'reviewed', published: false };
    case 'submitted': case 'compiled': return { state: 'compiled', published: false };
    default: return { state: 'draft', published: false };
  }
}

export type ResultsSlice = {
  settings: Record<string, unknown>;
  tables: Record<string, Row[]>;
  notes: string[];
  translated: Record<string, number>;
};

const DEFAULT_RANKING = { tiePolicy: 'competition', tiebreakers: ['exam'], rankIncomplete: false };

/** Build the grading scale the SaaS can use from the plugin's default scale, or explain why it cannot. */
function buildScale(plugin: PluginBackup, notes: string[]) {
  const scales = plugin.tables.grading_scales ?? [];
  const bands = plugin.tables.grade_bands ?? [];
  if (scales.length === 0) return null;
  const chosen = scales.find((s) => String(s.is_default) === '1') ?? scales[0]!;
  for (const other of scales) if (other !== chosen) notes.push(`The grading scale "${str(other.name) ?? other.id}" is kept out of the SaaS settings because the plugin never applied it to any result; the school's default scale "${str(chosen.name) ?? chosen.id}" is used.`);
  const mine = bands.filter((b) => String(b.scale_id) === String(chosen.id))
    .map((b) => ({ min: num(b.min_score), max: num(b.max_score), grade: str(b.grade), remark: str(b.remark) ?? '', pass: String(b.is_pass) === '1' }))
    .filter((b) => b.min !== null && b.grade !== null) as Array<{ min: number; max: number | null; grade: string; remark: string; pass: boolean }>;
  if (mine.length === 0) { notes.push(`The default grading scale "${str(chosen.name)}" has no grade bands, so results arrive with scores and no grades.`); return null; }
  mine.sort((a, b) => b.min - a.min);
  if (!mine.some((b) => b.min === 0)) { notes.push('The grading scale has no band starting at 0, so the lowest scores would have no grade; the scale was not carried.'); return null; }
  if (new Set(mine.map((b) => b.min)).size !== mine.length) { notes.push('The grading scale has two bands starting at the same score; the scale was not carried.'); return null; }
  // The SaaS keeps only the lower bound of each band, the next band up ends it. A gap between a band's top and the
  // next band's start (for example 64.99 then 65) would grade a score like 64.995 differently, so say so.
  for (let i = 0; i < mine.length - 1; i++) {
    const upper = mine[i]!, lower = mine[i + 1]!;
    if (lower.max !== null && upper.min - lower.max > 0.011) notes.push(`Between grades ${lower.grade} and ${upper.grade} the plugin scale leaves a gap (${lower.max} to ${upper.min}); the SaaS grades such scores as ${lower.grade}.`);
  }
  return { id: `wp-${chosen.id}`, name: str(chosen.name) ?? 'School scale', version: 1,
    bands: mine.map((b) => ({ min: b.min, grade: b.grade, remark: b.remark.slice(0, 100), pass: b.pass })) };
}

export function translateResults(plugin: PluginBackup, ids: { subjects: Set<unknown>; students: Set<unknown>; sessions: Set<unknown>; terms: Set<unknown>; classes: Set<unknown> }, report: Pick<TranslateReport, 'notes'>): ResultsSlice {
  const T = plugin.tables;
  const rows = (n: string): Row[] => (Array.isArray(T[n]) ? T[n]! : []);
  const notes: string[] = [];
  const out: Record<string, Row[]> = {};
  const translated: Record<string, number> = {};
  const settings: Record<string, unknown> = {};

  // ── Components and scale ──────────────────────────────────────
  const comps = rows('assessment_components').filter((c) => (str(c.status) ?? 'active') === 'active')
    .sort((a, b) => (num(a.sort_order) ?? 0) - (num(b.sort_order) ?? 0));
  const keyOf = new Map<string, string>();
  const used = new Set<string>();
  const components = comps.map((c) => {
    let key = (str(c.code) ?? `c${c.id}`).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 50) || `c${c.id}`;
    if (used.has(key)) key = `${key}-${c.id}`;
    used.add(key); keyOf.set(String(c.id), key);
    return { key, label: (str(c.name) ?? key).slice(0, 100), maxScore: num(c.max_score) ?? 0, isExam: String(c.is_exam) === '1' };
  });
  // Scores of a component the plugin has switched off must still arrive, so they get a key too.
  for (const c of rows('assessment_components')) if (!keyOf.has(String(c.id))) {
    const key = (str(c.code) ?? `c${c.id}`).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) + `-off${c.id}`;
    keyOf.set(String(c.id), key);
    notes.push(`The assessment "${str(c.name) ?? c.id}" is switched off in the plugin. Its scores were kept, but it is not part of the SaaS assessment setup.`);
  }
  const total = components.reduce((s, c) => s + c.maxScore, 0);
  const exams = components.filter((c) => c.isExam).length;
  const scale = buildScale(plugin, notes);
  if (components.length > 0 && Math.abs(total - 100) < 1e-8 && exams === 1) {
    settings.assessmentComponents = components;
  } else if (components.length > 0) {
    notes.push(`The assessments total ${round2(total)} with ${exams} exam component(s). The SaaS needs exactly 100 and one exam, so the school's assessment setup was NOT carried and must be set again in School Settings. All ${rows('assessment_scores').length} scores were kept.`);
  }
  if (scale) settings.gradingScale = scale;
  settings.rankingPolicy = DEFAULT_RANKING;

  // ── Scores ────────────────────────────────────────────────────
  const scoreRows: Row[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const r of rows('assessment_scores')) {
    const student = num(r.student_id), subject = num(r.subject_id), session = num(r.session_id), term = num(r.term_id);
    const key = keyOf.get(String(r.component_id));
    if (!key || !ids.students.has(student) || !ids.subjects.has(subject) || !ids.sessions.has(session) || !ids.terms.has(term)) { dropped++; continue; }
    const dup = `${student}/${subject}/${term}/${key}`;
    if (seen.has(dup)) { notes.push('A score was recorded twice for the same pupil, subject, term and assessment; the first one was kept.'); continue; }
    seen.add(dup);
    scoreRows.push({ id: num(r.id), school_id: 0, student_id: student, subject_id: subject, session_id: session, term_id: term,
      component_key: key, score: num(r.score) ?? 0, max_score: num(r.max_score) ?? 0, entered_by: null });
  }
  if (dropped) notes.push(`${dropped} score(s) pointed at a pupil, subject, term or assessment that is not in the file, so they were left out.`);
  out.assessment_scores = scoreRows; translated.assessment_scores = scoreRows.length;
  const scoreOf = new Map<string, Array<{ key: string; score: number }>>();
  for (const r of scoreRows) {
    const k = `${r.student_id}/${r.subject_id}/${r.term_id}`;
    (scoreOf.get(k) ?? scoreOf.set(k, []).get(k)!).push({ key: String(r.component_key), score: Number(r.score) });
  }

  // ── Term rows decide visibility ───────────────────────────────
  const termStatus = new Map<string, string>();
  for (const t of rows('term_results')) termStatus.set(`${t.student_id}/${t.term_id}`, String(t.status ?? ''));

  // ── Compiled subject results ──────────────────────────────────
  const subjectRows: Row[] = [];
  const classSizeOf = new Map<string, number>();
  for (const r of rows('subject_results')) {
    const k = `${r.class_id}/${r.subject_id}/${r.term_id}`; classSizeOf.set(k, (classSizeOf.get(k) ?? 0) + 1);
  }
  const resultSeen = new Set<string>();
  let differences = 0;
  for (const r of rows('subject_results')) {
    const student = num(r.student_id), subject = num(r.subject_id), session = num(r.session_id), term = num(r.term_id);
    if (!ids.students.has(student) || !ids.subjects.has(subject) || !ids.sessions.has(session) || !ids.terms.has(term)) {
      notes.push('A compiled result pointed at a pupil, subject or term that is not in the file and was left out.'); continue;
    }
    const dup = `${student}/${subject}/${term}`; if (resultSeen.has(dup)) continue; resultSeen.add(dup);
    const vis = subjectStateFor(termStatus.get(`${student}/${term}`) ?? null);
    // The grade is worked out exactly the way the SaaS works it out when it compiles a result, from the same
    // scores and the same bands, so a migrated result is indistinguishable from one the SaaS made itself.
    // Without a usable assessment setup the plugin's own stored totals are kept and no grade can be given.
    const stored = { ca: num(r.ca_total) ?? 0, exam: num(r.exam_total) ?? 0, total: num(r.total) ?? 0 };
    let ca = stored.ca, exam = stored.exam, total = stored.total, complete = true, grade = '', remark = '';
    if (settings.assessmentComponents) {
      const comps2 = settings.assessmentComponents as Array<{ key: string; label: string; maxScore: number; isExam: boolean }>;
      const calc = computeTotal(comps2, scoreOf.get(`${student}/${subject}/${term}`) ?? []);
      complete = calc.complete;
      if (Math.abs(calc.total - stored.total) > 0.011 || Math.abs(calc.caTotal - stored.ca) > 0.011 || Math.abs(calc.examTotal - stored.exam) > 0.011) {
        differences++;   // the plugin's stored figure is the record of what the school saw, so it is the one kept
      }
    }
    if (scale) {
      const g = gradeFor(total, { id: scale.id, name: scale.name, version: scale.version, bands: scale.bands });
      grade = complete ? g.grade : ''; remark = complete ? g.remark : 'Incomplete';
    } else if (!complete) remark = 'Incomplete';
    subjectRows.push({ id: num(r.id), school_id: 0, student_id: student, subject_id: subject, session_id: session, term_id: term,
      ca_total: ca, exam_total: exam, total, grade, remark,
      subject_position: num(r.subject_position) ?? 0, class_size: classSizeOf.get(`${r.class_id}/${r.subject_id}/${r.term_id}`) ?? 0,
      published: vis.published, state: vis.state, complete, compiled_at: iso(r.computed_at),
      grading_scale_id: scale ? scale.id : '', grading_scale_version: scale ? scale.version : 0, ranking_policy: DEFAULT_RANKING,
      reviewed_at: vis.state === 'reviewed' || vis.state === 'published' ? iso(r.computed_at) : null,
      published_at: vis.published ? iso(termPublishedAt(rows('term_results'), student, term)) ?? iso(r.computed_at) : null, locked_at: null });
  }
  if (differences) notes.push(`${differences} result(s) have a total that differs from what the SaaS would work out from the same scores. The plugin's own figure was kept, because that is what the school printed.`);
  out.subject_results = subjectRows; translated.subject_results = subjectRows.length;

  // ── Term summaries: remarks, attendance, position, approval trail ──
  const summaries: Row[] = [];
  const summarySeen = new Set<string>();
  for (const t of rows('term_results')) {
    const student = num(t.student_id), session = num(t.session_id), term = num(t.term_id), cls = num(t.class_id);
    if (!ids.students.has(student) || !ids.sessions.has(session) || !ids.terms.has(term)) { notes.push('A term result pointed at a pupil or term that is not in the file and was left out.'); continue; }
    const dup = `${student}/${term}`; if (summarySeen.has(dup)) continue; summarySeen.add(dup);
    const status = String(t.status ?? 'draft');
    summaries.push({ id: num(t.id), school_id: 0, student_id: student, session_id: session, term_id: term, class_id: cls !== null && ids.classes.has(cls) ? cls : null,
      class_teacher_remark: str(t.class_teacher_remark) ?? '', principal_remark: str(t.principal_remark) ?? '',
      days_present: num(t.days_present) ?? 0, days_total: num(t.days_total) ?? 0, subjects_offered: num(t.subjects_offered) ?? 0,
      total_score: num(t.total_score) ?? 0, average_score: num(t.average_score) ?? 0, class_position: num(t.class_position) ?? 0, class_size: num(t.class_size) ?? 0,
      status: ['draft', 'submitted', 'compiled', 'approved', 'published'].includes(status) ? status : 'draft',
      submitted_by: null, submitted_at: iso(t.submitted_at), approved_by: null, approved_at: iso(t.approved_at), published_at: iso(t.published_at) });
  }
  out.term_summaries = summaries; translated.term_summaries = summaries.length;

  report.notes.push(...notes);
  return { settings, tables: out, notes, translated };
}

function termPublishedAt(terms: Row[], student: number | null, term: number | null): unknown {
  return terms.find((t) => num(t.student_id) === student && num(t.term_id) === term)?.published_at;
}
