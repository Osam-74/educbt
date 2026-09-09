import { z } from 'zod';
import type { Actor } from '@/lib/session';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const resultScopeSchema = z.object({ classId: id, sessionId: id, termId: id });
export type ResultScope = z.infer<typeof resultScopeSchema>;
export const resultStateSchema = z.enum(['draft', 'compiled', 'reviewed', 'published', 'locked']);
const mark = z.number().finite().min(0).max(100).refine(n => Math.abs(n * 100 - Math.round(n * 100)) < 1e-8);
const configSchema = z.object({
  assessmentComponents: z.array(z.object({
    key: z.string().regex(/^[a-zA-Z0-9_-]{1,50}$/), label: z.string().trim().min(1).max(100),
    maxScore: mark.refine(n => n > 0), isExam: z.boolean(),
  })).min(1).max(20).refine(rows => new Set(rows.map(r => r.key)).size === rows.length
    && rows.filter(r => r.isExam).length === 1 && Math.abs(rows.reduce((s, r) => s + r.maxScore, 0) - 100) < 1e-8),
  gradingScale: z.object({
    id: z.string().trim().min(1).max(50), name: z.string().trim().min(1).max(100), version: id,
    bands: z.array(z.object({ min: mark, grade: z.string().trim().min(1).max(10), remark: z.string().max(100) }))
      .min(1).max(30).refine(b => b.some(r => r.min === 0) && new Set(b.map(r => r.min)).size === b.length),
  }),
  rankingPolicy: z.object({ tiePolicy: z.enum(['competition', 'dense', 'ordinal']),
    tiebreakers: z.array(z.enum(['exam', 'ca', 'none'])).max(3), rankIncomplete: z.boolean() }),
});
export type ResultConfig = z.infer<typeof configSchema>;
export function resultConfig(settings: Record<string, unknown>): ResultConfig | null {
  const parsed = configSchema.safeParse(settings);
  return parsed.success ? parsed.data : null;
}
export function canManageResults(actor: Actor) { return ['principal', 'vice_principal', 'exam_officer'].includes(actor.role); }
