import { z } from 'zod';
import { resultConfig } from '@/lib/results/config';
import { WAEC_NINE_POINT, DEFAULT_RANKING } from '@/domain/academic';

const text = (max: number) => z.string().trim().max(max);
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const date = z.string().refine(s => !s || /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s, 'Use a valid calendar date.');
const dates = { startsOn: date, endsOn: date };
const ordered = (v: { startsOn: string; endsOn: string }) => !v.startsOn || !v.endsOn || v.startsOn <= v.endsOn;
export const profileSchema = z.object({ name: text(191).min(1), address: text(1000), phone: text(50),
  email: z.union([z.literal(''), z.string().email().max(191)]), principalName: text(191),
  website: z.union([z.literal(''), z.string().url().max(191).refine(s => /^https?:\/\//i.test(s))]) }).strict();
export const sessionSchema = z.object({ title: text(100).min(1), ...dates, makeCurrent: z.boolean() }).strict().refine(ordered, 'End date must follow start date.');
export const termSchema = z.object({ sessionId: id, termId: id.optional(), title: text(100).min(1), position: z.number().int().min(1).max(12), ...dates }).strict().refine(ordered, 'End date must follow start date.');
export const periodSchema = z.object({ sessionId: id, termId: id }).strict();
export const defaultConfig = { assessmentComponents: [{ key: 'ca1', label: 'Continuous assessment', maxScore: 40, isExam: false },
  { key: 'exam', label: 'Examination', maxScore: 60, isExam: true }], gradingScale: WAEC_NINE_POINT, rankingPolicy: DEFAULT_RANKING };
export function parseAcademic(value: unknown) {
  const config = value && typeof value === 'object' ? resultConfig(value as Record<string, unknown>) : null;
  if (!config) throw new Error('Check assessment keys and maxima: total 100, exactly one exam. Grade bands need unique minima covering 0–100.');
  if (new Set(config.gradingScale.bands.map(b => b.grade)).size !== config.gradingScale.bands.length) throw new Error('Each grade must be unique.');
  const tie = config.rankingPolicy.tiebreakers;
  if (new Set(tie).size !== tie.length || tie.includes('none') && tie.length > 1) throw new Error('Choose unique tiebreakers, or none on its own.');
  return config;
}
export function componentStructure(rows: typeof defaultConfig.assessmentComponents) {
  return JSON.stringify(rows.map(({ key, maxScore, isExam }) => ({ key, maxScore, isExam })).sort((a, b) => a.key.localeCompare(b.key)));
}
export const signatureSchema = z.object({ role: z.enum(['principal', 'class_teacher', 'exam_officer']), name: text(191).min(1),
  type: z.enum(['text', 'upload']), text: text(191) }).strict().refine(v => v.type !== 'text' || v.text.length > 0, 'Enter your typed signature.');
export const rangeSchema = z.array(z.object({ min: z.number().finite().min(0).max(100), remark: text(500).min(1) }).strict()).max(30)
  .refine(rows => !rows.length || rows.some(r => r.min === 0) && new Set(rows.map(r => r.min)).size === rows.length, 'Ranges must start at 0 with unique minimum scores.');
export function suggestedRemark(ranges: z.infer<typeof rangeSchema>, average: number) {
  return [...ranges].sort((a, b) => b.min - a.min).find(r => average >= r.min)?.remark ?? null;
}
export const examDefaultsSchema = z.object({ durationMinutes: z.number().int().min(5).max(300) }).strict();
