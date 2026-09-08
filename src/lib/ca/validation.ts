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
const componentsSchema = z.array(z.object({
  key: caScopeSchema.shape.componentKey, label: z.string().trim().min(1).max(100),
  maxScore: marks.refine(n => n > 0), isExam: z.boolean(),
})).min(1).max(20).refine(rows => new Set(rows.map(r => r.key)).size === rows.length);

/** No guessed grading policy: absent or invalid configuration disables entry. */
export function caComponents(settings: Record<string, unknown>): AssessmentComponent[] {
  const parsed = componentsSchema.safeParse(settings.assessmentComponents);
  return parsed.success ? parsed.data.filter(c => !c.isExam) : [];
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
