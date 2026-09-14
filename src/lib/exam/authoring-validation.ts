import { z } from 'zod';

export const authoringScopeSchema = z.object({
  sessionId: z.number().int().positive(), termId: z.number().int().positive(),
  subjectId: z.number().int().positive(), levelId: z.number().int().positive(),
  departmentId: z.number().int().positive().nullable(), examType: z.enum(['objective', 'theory']),
  seriesId: z.number().int().nonnegative(), waecMode: z.boolean(),
});
export const quotasSchema = z.object({ objective: z.coerce.number().int().min(1).max(500), theory: z.coerce.number().int().min(1).max(100) });
export const collectionSchema = quotasSchema.extend({ seriesId: z.coerce.number().int().positive().nullable() });
export function authoringConfig(settings: Record<string, unknown>) {
  const result = collectionSchema.safeParse(settings.questionBank);
  return result.success ? result.data : { objective: 20, theory: 4, seriesId: null };
}
export const questionInputSchema = z.object({
  text: z.string().trim().min(5, 'Write a question of at least five characters.').max(20000),
  marks: z.number().finite().positive().max(9999.99).refine(v => Math.abs(v * 100 - Math.round(v * 100)) < 1e-7, 'Use at most two decimal places for marks.'),
  section: z.string().trim().max(100).optional(), passageId: z.number().int().positive().nullable().optional(),
  instructions: z.string().trim().max(10000).nullable().optional(), imageUrl: z.string().url().max(2000).nullable().optional(),
  noShuffle: z.boolean().optional(), markingGuide: z.string().trim().max(20000).nullable().optional(),
  options: z.array(z.object({ text: z.string().trim().max(5000), isCorrect: z.boolean() })).max(10).optional(),
});
export function validateQuestion(input: unknown, type: 'objective' | 'theory') {
  const value = questionInputSchema.parse(input);
  if (type === 'objective') {
    const options = (value.options ?? []).filter(o => o.text);
    if (options.length < 2) throw new Error('An objective question needs at least two options.');
    if (options.filter(o => o.isCorrect).length !== 1) throw new Error('Mark exactly one correct option.');
    if (new Set(options.map(o => o.text.toLocaleLowerCase('en'))).size !== options.length) throw new Error('Options must have distinct text.');
    value.options = options;
  }
  return value;
}
export function collectionIsOpen(series: { status: string; seriesType: string; questionsOpenFrom: Date | null; questionsOpenTo: Date | null }, now = new Date()) {
  if (['closed', 'cancelled'].includes(series.status)) return false;
  if (series.seriesType === 'practice') return true;
  if (!['draft', 'open'].includes(series.status)) return false;
  return Boolean(series.questionsOpenFrom && series.questionsOpenTo &&
    now >= series.questionsOpenFrom && now < series.questionsOpenTo);
}
