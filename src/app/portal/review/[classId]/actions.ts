'use server';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { requireSchoolSession } from '@/lib/session';
import { forSchool, schema } from '@/db';
import { subjectResults } from '@/db/schema/results';
import { resultConfig, resultScopeSchema, canManageResults } from '@/lib/results/config';
import { compileClassResults, ResultError } from '@/lib/results/workflow';
import { lockResultTerm } from '@/lib/ca/lock';
import { isEditable } from '@/domain/academic';

export type ModerationState = { ok: boolean; message: string };

/**
 * Save & Recompile — the plugin's educbt_moderate_results, adapted to the
 * audited lifecycle: one transaction writes every moderated component score
 * (upserting assessment_scores with the school-scoped unique key), refuses
 * if any affected subject result is outside the editable states, marks
 * touched compiled rows stale (draft), then recompiles the class so totals,
 * grades and positions are recomputed before sign-off.
 */
export async function saveModeration(_previous: ModerationState, form: FormData): Promise<ModerationState> {
  const actor = await requireSchoolSession();
  if (!canManageResults(actor)) return { ok: false, message: 'You do not have access to result moderation.' };

  const scope = resultScopeSchema.safeParse({
    classId: Number(form.get('classId')), sessionId: Number(form.get('sessionId')), termId: Number(form.get('termId')),
  });
  if (!scope.success) return { ok: false, message: 'Choose a valid class, session and term.' };

  type Entry = { studentId: number; subjectId: number; componentKey: string; score: number };
  const entries: Entry[] = [];

  try {
    const upserted = await forSchool(actor.schoolId, async (tx) => {
      // The term is locked against concurrent result moves while we write.
      await lockResultTerm(tx, actor.schoolId, scope.data.sessionId, scope.data.termId);

      const [classroom] = await tx.select().from(schema.classes)
        .where(and(eq(schema.classes.id, scope.data.classId), eq(schema.classes.status, 'active'))).limit(1);
      const [term] = await tx.select().from(schema.terms)
        .where(and(eq(schema.terms.id, scope.data.termId), eq(schema.terms.sessionId, scope.data.sessionId))).limit(1);
      const [school] = await tx.select({ settings: schema.schools.settings })
        .from(schema.schools).where(eq(schema.schools.id, actor.schoolId)).limit(1);
      if (!classroom || !term) return { error: 'This academic scope is unavailable.', count: 0 };

      const config = resultConfig((school?.settings as Record<string, unknown>) ?? {});
      if (!config) return { error: 'Academic settings are incomplete. Compilation is unavailable.', count: 0 };

      // Enrolled students and their registered subjects — a moderation entry
      // for a student or subject outside this class is rejected, not saved.
      const enrolled = await tx.select({ studentId: schema.enrollments.studentId })
        .from(schema.enrollments)
        .where(and(eq(schema.enrollments.classId, scope.data.classId), eq(schema.enrollments.sessionId, scope.data.sessionId),
          eq(schema.enrollments.status, 'active')));
      const enrolledIds = enrolled.map((e) => Number(e.studentId));
      if (enrolledIds.length === 0) return { error: 'No students enrolled in this class.', count: 0 };

      const registered = await tx.select({ studentId: schema.studentSubjects.studentId, subjectId: schema.studentSubjects.subjectId })
        .from(schema.studentSubjects)
        .where(and(inArray(schema.studentSubjects.studentId, enrolledIds), eq(schema.studentSubjects.sessionId, scope.data.sessionId)));
      const registeredKeys = new Set(registered.map((r) => `${Number(r.studentId)}:${Number(r.subjectId)}`));

      const caKeys = new Map(config.assessmentComponents.filter((c) => !c.isExam).map((c) => [c.key, c]));

      for (const [name, raw] of form.entries()) {
        if (!name.startsWith('m:') || typeof raw !== 'string' || !raw.trim()) continue;
        const parts = name.split(':');
        const studentId = Number(parts[1]);
        const subjectId = Number(parts[2]);
        const component = parts[3] ? caKeys.get(parts[3]) : undefined;
        if (!component || !Number.isInteger(studentId) || !Number.isInteger(subjectId)) {
          return { error: 'One of the submitted scores does not match a configured component.', count: 0 };
        }
        const componentKey = parts[3]!;
        if (!registeredKeys.has(`${studentId}:${subjectId}`)) {
          return { error: 'A score was submitted for a subject this class does not offer.', count: 0 };
        }
        const score = Number(raw);
        if (!Number.isFinite(score) || score < 0 || score > component.maxScore
          || Math.abs(score * 100 - Math.round(score * 100)) > 1e-8) {
          return { error: `Scores must be between 0 and ${component.maxScore}, with at most two decimal places.`, count: 0 };
        }
        entries.push({ studentId, subjectId, componentKey, score });
      }

      if (entries.length === 0) return { error: 'No scores to save — every input was blank.', count: 0 };

      // Lifecycle guard: an entry against a reviewed/published/locked subject
      // result is refused wholesale (the same guarantee enterScore gives).
      const touchedSubjects = [...new Set(entries.map((e) => e.subjectId))];
      const existingResults = await tx.select({
        id: subjectResults.id, studentId: subjectResults.studentId, subjectId: subjectResults.subjectId,
        state: subjectResults.state, published: subjectResults.published,
      }).from(subjectResults).where(and(
        eq(subjectResults.schoolId, actor.schoolId),
        eq(subjectResults.sessionId, scope.data.sessionId),
        eq(subjectResults.termId, scope.data.termId),
        inArray(subjectResults.studentId, enrolledIds),
        inArray(subjectResults.subjectId, touchedSubjects),
      )).for('update');

      const resultBySubjectKey = new Map(existingResults.map((r) => [`${Number(r.studentId)}:${Number(r.subjectId)}`, r]));
      for (const entry of entries) {
        const existing = resultBySubjectKey.get(`${entry.studentId}:${entry.subjectId}`);
        if (existing && (!isEditable(existing.state) || existing.published)) {
          return { error: 'These results are reviewed, published or locked. Reopen them through the result lifecycle before moderating.', count: 0 };
        }
      }

      await tx.insert(schema.assessmentScores).values(entries.map((e) => ({
        schoolId: actor.schoolId, studentId: e.studentId, subjectId: e.subjectId,
        sessionId: scope.data.sessionId, termId: scope.data.termId, componentKey: e.componentKey,
        score: String(e.score),
        maxScore: String(caKeys.get(e.componentKey)!.maxScore),
        enteredBy: actor.userId, updatedAt: new Date(),
      }))).onConflictDoUpdate({
        // Matches the assessment_scores unique key exactly — a narrower
        // conflict target silently updates another context's row. Each
        // conflicting row takes its own submitted values via excluded.*.
        target: [
          schema.assessmentScores.schoolId,
          schema.assessmentScores.studentId,
          schema.assessmentScores.subjectId,
          schema.assessmentScores.sessionId,
          schema.assessmentScores.termId,
          schema.assessmentScores.componentKey,
        ],
        set: {
          score: sql`excluded.score`,
          maxScore: sql`excluded.max_score`,
          enteredBy: sql`excluded.entered_by`,
          updatedAt: sql`excluded.updated_at`,
        },
      });

      // A changed score makes a prior compilation stale: touched compiled
      // rows go back to draft so the class must be compiled again before
      // review/publication (the same rule enterScore enforces per row).
      const touchedPairs = new Set(entries.map((e) => `${e.studentId}:${e.subjectId}`));
      const staleRows = existingResults.filter((r) => touchedPairs.has(`${Number(r.studentId)}:${Number(r.subjectId)}`) && r.state === 'compiled');
      if (staleRows.length) {
        await tx.update(subjectResults).set({ state: 'draft', complete: false })
          .where(inArray(subjectResults.id, staleRows.map((r) => r.id)));
      }

      return { error: '', count: entries.length };
    });

    if (upserted.error) return { ok: false, message: upserted.error };
  } catch (error) {
    if (error instanceof ResultError) return { ok: false, message: error.message };
    return { ok: false, message: 'The moderated scores could not be saved. Reload to check the stored scores before retrying.' };
  }

  // All writes landed: recompile so totals, grades and positions are honest.
  try {
    const compiled = await compileClassResults(actor, scope.data);
    revalidatePath('/portal/results'); revalidatePath('/portal/broadsheet');
    revalidatePath(`/portal/review/${scope.data.classId}`);
    return { ok: true, message: `${entries.length} score(s) saved and ${compiled.compiled} subject results recompiled. The class is ready for sign-off.` };
  } catch (error) {
    if (error instanceof ResultError) return { ok: false, message: `Scores saved, but compilation failed: ${error.message}` };
    return { ok: false, message: 'Scores saved, but compilation failed. Reload and compile from the results page.' };
  }
}

