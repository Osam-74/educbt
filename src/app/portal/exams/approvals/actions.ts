'use server';
import { redirect } from 'next/navigation';
import { requireSchoolSession, requireRole, SCHOOL_WIDE } from '@/lib/session';
import { collectionView, saveCollection } from '@/lib/exam/collection';
import { deleteSet } from '@/lib/exam/sets';
import { backupSchool, restoreSchool } from '@/lib/exam/vault';

function back(query: Record<string, string>) {
  const params = new URLSearchParams(Object.entries(query).filter(([, v]) => v));
  redirect(`/portal/exams/approvals?${params.toString()}`);
}

/**
 * "Minimum required per subject" (legacy parity: the quota half of the
 * plugin's collection settings). The open collection window itself stays a
 * Papers-office decision (Exam Papers already opens/closes it and preserves
 * these same quotas when it does) — this only ever touches objective/theory.
 */
export async function saveRequirement(form: FormData) {
  const actor = await requireSchoolSession();
  requireRole(actor, SCHOOL_WIDE);
  const returnQuery = Object.fromEntries(new URLSearchParams(String(form.get('returnQuery') ?? '')));

  try {
    const current = await collectionView(actor);
    await saveCollection(actor, {
      seriesId: current.config.seriesId,
      objective: Number(form.get('objective')),
      theory: Number(form.get('theory')),
    });
  } catch (e) {
    back({ ...returnQuery, error: e instanceof Error ? e.message : 'Could not save that requirement.' });
    return;
  }
  back({ ...returnQuery, ok: 'requirement' });
}

export async function backupNow(form: FormData) {
  const actor = await requireSchoolSession();
  requireRole(actor, SCHOOL_WIDE);
  const returnQuery = Object.fromEntries(new URLSearchParams(String(form.get('returnQuery') ?? '')));

  try {
    const result = await backupSchool(actor.schoolId);
    back({ ...returnQuery, ok: `Backed up ${result.setsBackedUp} of ${result.totalSets} set(s).` });
  } catch (e) {
    back({ ...returnQuery, error: e instanceof Error ? e.message : 'Backup failed.' });
  }
}

export async function restoreNow(form: FormData) {
  const actor = await requireSchoolSession();
  requireRole(actor, SCHOOL_WIDE);
  const returnQuery = Object.fromEntries(new URLSearchParams(String(form.get('returnQuery') ?? '')));

  try {
    const result = await restoreSchool(actor.schoolId);
    back({
      ...returnQuery,
      ok: result.restoredQuestions > 0
        ? `Restored ${result.restoredQuestions} question(s) across ${result.touchedSets} set(s).`
        : 'Nothing needed restoring — every backed-up set already has its questions.',
    });
  } catch (e) {
    back({ ...returnQuery, error: e instanceof Error ? e.message : 'Restore failed.' });
  }
}

export async function deleteSubmission(form: FormData) {
  const actor = await requireSchoolSession();
  requireRole(actor, SCHOOL_WIDE);
  const returnQuery = Object.fromEntries(new URLSearchParams(String(form.get('returnQuery') ?? '')));
  const setId = Number(form.get('setId'));

  try {
    await deleteSet(actor, setId);
  } catch (e) {
    back({ ...returnQuery, error: e instanceof Error ? e.message : 'Could not delete that submission.' });
    return;
  }
  back({ ...returnQuery, ok: 'Submission deleted.' });
}
