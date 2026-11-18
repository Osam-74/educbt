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
export const questionPartSchema = z.object({
  label: z.string().trim().min(1, 'Give each part a label such as a or b.').max(10),
  text: z.string().trim().min(1, 'Write the text of each part.').max(10000),
  marks: z.number().finite().positive().max(9999.99).refine(v => Math.abs(v * 100 - Math.round(v * 100)) < 1e-7, 'Use at most two decimal places for marks.'),
});
export type QuestionPartInput = z.infer<typeof questionPartSchema>;

/**
 * The labelled parts of a theory question, such as (a) 2 marks and (b) 3 marks. Parts describe how a question's
 * marks are split; marking still awards one score for the whole question. Returns the cleaned parts, or an empty
 * list when none were given (the question then behaves exactly as it always has).
 */
export function validateQuestionParts(parts: unknown, questionMarks: number, type: 'objective' | 'theory'): QuestionPartInput[] {
  if (parts === undefined || parts === null) return [];
  const list = z.array(questionPartSchema).max(10, 'A question can have at most 10 parts.').parse(parts);
  if (list.length === 0) return [];
  if (type !== 'theory') throw new Error('Only theory questions can have parts.');
  const labels = list.map(p => p.label.toLocaleLowerCase('en'));
  if (new Set(labels).size !== labels.length) throw new Error('Each part needs a different label.');
  // Whole cents, so 0.1 + 0.2 style float drift can never reject (or admit) a split.
  const cents = list.reduce((sum, p) => sum + Math.round(p.marks * 100), 0);
  if (cents !== Math.round(questionMarks * 100)) {
    throw new Error(`The parts add up to ${cents / 100} but the question is worth ${questionMarks}. Make them match.`);
  }
  return list;
}
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
