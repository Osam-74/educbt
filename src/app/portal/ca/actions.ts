'use server';

import { revalidatePath } from 'next/cache';
import { requireSchoolSession } from '@/lib/session';
import { enterScore } from '@/lib/exam/results';
import { parseCaForm, parseCaSheetForm } from '@/lib/ca/validation';

export type SaveState = { ok: boolean; message: string };
export async function saveCaScore(_previous: SaveState, form: FormData): Promise<SaveState> {
  const actor = await requireSchoolSession();
  const input = parseCaForm(form);
  if (!input) return { ok: false, message: 'Enter a score with at most two decimal places. Blank is not zero.' };
  try {
    const result = await enterScore(actor, input);
    if (!result.ok) return { ok: false, message: result.error ?? 'The score could not be saved.' };
  } catch {
    return { ok: false, message: 'The score could not be saved. Your entry is still here; retry or reload to check the stored score.' };
  }
  revalidatePath('/portal/ca');
  return { ok: true, message: 'Score saved. Results must be compiled again before review.' };
}

/**
 * One Save button writes every filled box on the sheet — ported from the
 * plugin's teacher/scores.php. Each cell reuses the same validated,
 * lock-checked `enterScore` write as the single-score form; a cell that
 * fails (e.g. the class was locked mid-edit) is reported without discarding
 * the cells that already saved.
 */
export async function saveCaSheet(_previous: SaveState, form: FormData): Promise<SaveState> {
  const actor = await requireSchoolSession();
  const parsed = parseCaSheetForm(form);
  if (!parsed) return { ok: false, message: 'This score sheet is out of date. Reload and try again.' };
  if (!parsed.cells.length) return { ok: false, message: 'No scores were entered. Blank boxes are not saved.' };
  let saved = 0;
  const errors = new Set<string>();
  for (const cell of parsed.cells) {
    try {
      const result = await enterScore(actor, {
        classId: parsed.classId, subjectId: parsed.subjectId, sessionId: parsed.sessionId,
        termId: parsed.termId, componentKey: cell.componentKey, studentId: cell.studentId,
        score: cell.score, maxScore: cell.maxScore,
      });
      if (result.ok) saved += 1; else errors.add(result.error ?? 'A score could not be saved.');
    } catch {
      errors.add('A score could not be saved. Retry or reload to check what is stored.');
    }
  }
  revalidatePath('/portal/ca');
  if (errors.size) {
    return { ok: saved > 0, message: `Saved ${saved} of ${parsed.cells.length} score(s). ${[...errors].join(' ')}` };
  }
  return { ok: true, message: `Saved ${saved} score(s). Results must be compiled again before review.` };
}
