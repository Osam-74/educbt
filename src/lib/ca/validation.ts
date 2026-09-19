import { z } from 'zod';
import type { AssessmentComponent } from '@/domain/academic';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const marks = z.number().finite().min(0).max(9999.99).refine(
  n => Math.abs(n * 100 - Math.round(n * 100)) < 1e-8,
  'Use at most two decimal places.',
);
export const caScopeSchema = z.object({
  classId: id, subjectId: id, sessionId: id, termId: id,
  componentKey: z.string().regex(/^[a-zA-Z0-9_-]{1,50}$/),
});
export type CaScope = z.infer<typeof caScopeSchema>;
export const caScoreSchema = caScopeSchema.omit({ classId: true }).extend({
  classId: id.optional(), studentId: id, score: marks, maxScore: marks.refine(n => n > 0),
});
export type CaScoreInput = z.infer<typeof caScoreSchema>;
/** The whole score sheet (class + subject); the current term is resolved server-side. */
export const caSheetScopeSchema = z.object({ classId: id, subjectId: id });
export type CaSheetScope = z.infer<typeof caSheetScopeSchema>;
const componentsSchema = z.array(z.object({
  key: caScopeSchema.shape.componentKey, label: z.string().trim().min(1).max(100),
  maxScore: marks.refine(n => n > 0), isExam: z.boolean(),
})).min(1).max(20).refine(rows => new Set(rows.map(r => r.key)).size === rows.length);

/**
 * All configured components, CA and exam alike, unfiltered — for the full
 * score sheet, which shows the exam column too. Deliberately as lenient as
 * `caComponents`: entry must not be blocked by grading-scale/ranking-policy
 * setup that `enterScore` never required either (see lib/results/config.ts
 * for the stricter schema the results-compile pipeline enforces instead).
 */
export function caComponentsAll(settings: Record<string, unknown>): AssessmentComponent[] {
  const parsed = componentsSchema.safeParse(settings.assessmentComponents);
  return parsed.success ? parsed.data : [];
}

/** No guessed grading policy: absent or invalid configuration disables entry. */
export function caComponents(settings: Record<string, unknown>): AssessmentComponent[] {
  return caComponentsAll(settings).filter(c => !c.isExam);
}

/** Blank must never become zero through Number(''); files and duplicates are rejected. */
export function parseCaForm(form: FormData) {
  const values: Record<string, unknown> = {};
  for (const name of ['classId', 'subjectId', 'sessionId', 'termId', 'studentId', 'componentKey', 'score', 'maxScore']) {
    const all = form.getAll(name);
    if (all.length !== 1 || typeof all[0] !== 'string' || !all[0].trim()) return null;
    values[name] = name === 'componentKey' ? all[0] : Number(all[0]);
  }
  const result = caScoreSchema.safeParse(values);
  return result.success ? result.data : null;
}

/**
 * One row per student per CA/assignment component present in the posted grid
 * (`score[<studentId>][<componentKey>]`). A blank box is skipped — never
 * coerced to zero — exactly like the single-cell form. classId/sessionId/
 * termId/subjectId are read once from the sheet-level hidden fields.
 */
export function parseCaSheetForm(form: FormData) {
  const classId = Number(form.get('classId'));
  const subjectId = Number(form.get('subjectId'));
  const sessionId = Number(form.get('sessionId'));
  const termId = Number(form.get('termId'));
  const scope = caSheetScopeSchema.omit({ classId: true }).extend({ classId: id, sessionId: id, termId: id })
    .safeParse({ classId, subjectId, sessionId, termId });
  if (!scope.success) return null;
  const cells: Array<{ studentId: number; componentKey: string; score: number; maxScore: number }> = [];
  for (const [name, value] of form.entries()) {
    const match = /^score\[(\d+)\]\[([a-zA-Z0-9_-]{1,50})\]$/.exec(name);
    if (!match || typeof value !== 'string' || !value.trim()) continue;
    const maxScore = Number(form.get(`max[${match[2]}]`));
    const parsed = caScoreSchema.safeParse({
      classId, subjectId, sessionId, termId, componentKey: match[2],
      studentId: Number(match[1]), score: Number(value), maxScore,
    });
    if (parsed.success) cells.push({
      studentId: parsed.data.studentId, componentKey: parsed.data.componentKey,
      score: parsed.data.score, maxScore: parsed.data.maxScore,
    });
  }
  return { classId, subjectId, sessionId, termId, cells };
}
