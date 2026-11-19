/**
 * Plugin -> SaaS migration, slice 3: the question bank. Pure functions, no database.
 *
 * The plugin keeps questions OUTSIDE any exam set, with a lot of detail the SaaS set-based questions cannot hold
 * (topic, difficulty, Bloom level, exam year, duration, explanation, marking guide). They go into the SaaS bank
 * tables (migration 0029), field for field, so nothing is flattened or lost.
 *
 * What the plugin really stores (verified against a real plugin school, not assumed):
 *  - Options live in TWO places depending on when the question was written: old questions hold them as a JSON
 *    list in questions.options with the correct answer(s) as a JSON list of option TEXTS in questions.answers;
 *    newer questions hold question_options rows with an is_correct flag. Both are read, and the rows win when both exist.
 *  - question_type is not clean: 'objective', 'single', 'theory', and a bare 0 left by an old import. The plugin's
 *    own rule is that a blank type is 'objective'. A type this code does not know is kept as written, never guessed.
 *  - Theory parts are question_sub_items rows.
 *  - Subject is free text. It is linked to a subject when the name matches one, and the text is ALWAYS kept.
 */
import type { PluginBackup } from './from-plugin';

type Row = Record<string, unknown>;
export type QuestionSlice = { tables: Record<string, Row[]> };

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());
const strOrNull = (v: unknown): string | null => { const s = str(v); return s === '' ? null : s; };
const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const link = (v: unknown): number | null => { const n = num(v); return n === null || n === 0 ? null : n; };
const iso = (v: unknown): string | null => {
  const s = str(v); if (!s || s.startsWith('0000')) return null;
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** Parse a JSON list stored as text; anything that is not a list of strings becomes no list. */
function jsonList(v: unknown): string[] | null {
  if (Array.isArray(v)) return v.map((x) => str(x));
  const s = str(v);
  if (!s || s === '0') return null;
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed.map((x) => str(x)) : null;
  } catch { return null; }
}

/** The plugin's own rule: blank means objective. 'single' is its single-answer form. Unknown values are kept as written. */
export function questionTypeOf(raw: unknown): string {
  const t = str(raw).toLowerCase();
  if (t === '' || t === '0') return 'objective';
  return t;
}

const STATUS: Record<string, string> = { published: 'published', active: 'published', draft: 'draft', archived: 'archived', inactive: 'archived', '0': 'draft' };
const APPROVAL: Record<string, string> = { pending: 'pending', approved: 'approved', revision: 'revision', rejected: 'revision' };
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * @param subjectByName lower-cased subject name -> subject id in the file
 */
export function translateQuestions(
  plugin: PluginBackup,
  known: { subjects: Map<string, number>; staff: Set<unknown> },
  report: { notes: string[] },
): QuestionSlice {
  const T = plugin.tables ?? {};
  const rows = (n: string): Row[] => (Array.isArray(T[n]) ? T[n]! : []);
  const out: Record<string, Row[]> = {};

  const optionRows = new Map<number, Row[]>();
  for (const o of rows('question_options')) {
    const q = num(o.question_id); if (q === null) continue;
    (optionRows.get(q) ?? optionRows.set(q, []).get(q)!).push(o);
  }
  const partRows = new Map<number, Row[]>();
  for (const p of rows('question_sub_items')) {
    const q = num(p.question_id); if (q === null) continue;
    (partRows.get(q) ?? partRows.set(q, []).get(q)!).push(p);
  }

  const questions: Row[] = [], options: Row[] = [], parts: Row[] = [];
  const seen = new Set<number>();
  let unlinkedSubjects = 0, noAnswer = 0, mixedTypes = 0;
  const ids = new Set(rows('questions').map((q) => num(q.id)));

  for (const q of rows('questions')) {
    const id = num(q.id); if (id === null || seen.has(id)) continue; seen.add(id);
    const subjectName = str(q.subject);
    const subjectId = known.subjects.get(subjectName.toLowerCase()) ?? null;
    if (subjectName && subjectId === null) unlinkedSubjects++;
    const type = questionTypeOf(q.question_type);
    if (!['objective', 'single', 'theory', 'multiple', 'true_false'].includes(type)) mixedTypes++;
    const parent = link(q.parent_id);

    questions.push({
      id, school_id: 0, subject_id: subjectId, subject_name: subjectName, class_label: str(q.class), department_label: str(q.department),
      section: str(q.section), topic: str(q.topic), sub_topic: str(q.sub_topic), difficulty: str(q.difficulty), bloom_level: str(q.bloom_level),
      learning_objective: str(q.learning_objective), examination_type: str(q.examination_type), examination_year: str(q.examination_year),
      question_type: type, marks: num(q.marks) ?? 1, estimated_seconds: num(q.estimated_duration) ?? 0,
      question_text: str(q.question_text), passage_text: str(q.passage_text), image_url: strOrNull(q.image_reference),
      explanation: str(q.explanations), marking_guide: str(q.marking_guide),
      status: STATUS[str(q.status).toLowerCase()] ?? 'draft', approval_status: APPROVAL[str(q.approval_status).toLowerCase()] ?? 'pending',
      review_note: str(q.review_note) || str(q.reviewer_comment), reviewed_by: null, reviewed_at: iso(q.reviewed_at),
      source_method: str(q.source_method) || 'manual', author_staff_id: null,
      parent_id: parent !== null && ids.has(parent) ? parent : null, part_label: str(q.part_label), sequence: num(q.sequence) ?? 0,
      created_at: iso(q.created_at), updated_at: iso(q.updated_at),
    });
    if (parent !== null && !ids.has(parent)) report.notes.push(`Question ${id} pointed at a parent question that is not in the file; it was kept without the link.`);

    // Options: rows win; otherwise the old JSON list, with the correct ones named by their TEXT.
    const rowOpts = (optionRows.get(id) ?? []).slice().sort((a, b) => (num(a.sort_order) ?? 0) - (num(b.sort_order) ?? 0));
    if (rowOpts.length) {
      for (const [i, o] of rowOpts.entries()) {
        options.push({ id: num(o.id), school_id: 0, question_id: id, option_key: str(o.option_key) || LETTERS[i] || '', option_text: str(o.option_text),
          image_url: strOrNull(o.option_image), is_correct: o.is_correct === true || o.is_correct === 1 || o.is_correct === '1', sort_order: num(o.sort_order) ?? i });
      }
    } else {
      const list = jsonList(q.options);
      if (list && list.length) {
        const correct = new Set((jsonList(q.answers) ?? []).map((a) => a.toLowerCase()));
        let hits = 0;
        list.forEach((text, i) => {
          const ok = correct.has(text.toLowerCase()); if (ok) hits++;
          options.push({ id: null, school_id: 0, question_id: id, option_key: LETTERS[i] ?? String(i + 1), option_text: text, image_url: null, is_correct: ok, sort_order: i });
        });
        if (hits === 0 && correct.size > 0) report.notes.push(`Question ${id}: none of its options matched the stored answer, so no option is marked correct. The answer is kept in the explanation.`);
        if (hits === 0) noAnswer++;
      }
    }

    // A stored answer that matched no option must never vanish: it is appended to the explanation.
    const stored = jsonList(q.answers);
    const marked = options.filter((o) => o.question_id === id && o.is_correct).length;
    if (stored && stored.length && marked === 0 && options.some((o) => o.question_id === id)) {
      const last = questions[questions.length - 1]!;
      last.explanation = [str(last.explanation), `Stored answer: ${stored.join('; ')}`].filter(Boolean).join('\n');
    }
    if (stored && stored.length && !options.some((o) => o.question_id === id)) {
      const last = questions[questions.length - 1]!;
      last.explanation = [str(last.explanation), `Stored answer: ${stored.join('; ')}`].filter(Boolean).join('\n');
    }

    for (const [i, p] of (partRows.get(id) ?? []).slice().sort((a, b) => (num(a.sequence) ?? 0) - (num(b.sequence) ?? 0)).entries()) {
      parts.push({ id: num(p.id), school_id: 0, question_id: id, label: str(p.label), text: str(p.text), marks: num(p.marks) ?? 0, sequence: num(p.sequence) ?? i });
    }
  }

  const orphanOptions = [...optionRows.keys()].filter((k) => !ids.has(k)).length;
  const orphanParts = [...partRows.keys()].filter((k) => !ids.has(k)).length;
  if (orphanOptions) report.notes.push(`${orphanOptions} question(s) had options in the file but the question itself was missing, so those options were left out.`);
  if (orphanParts) report.notes.push(`${orphanParts} question(s) had theory parts in the file but the question itself was missing, so those parts were left out.`);
  if (unlinkedSubjects) report.notes.push(`${unlinkedSubjects} question(s) are for a subject name that matches no subject in the school. The subject name is kept on the question, so nothing is lost.`);
  if (mixedTypes) report.notes.push(`${mixedTypes} question(s) have a question type the platform does not know. The type was kept as written.`);

  out.bank_questions = questions; out.bank_question_options = options; out.bank_question_parts = parts;
  return { tables: out };
}
