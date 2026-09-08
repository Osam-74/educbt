'use server';

import { revalidatePath } from 'next/cache';
import { requireSchoolSession } from '@/lib/session';
import { enterScore } from '@/lib/exam/results';
import { parseCaForm } from '@/lib/ca/validation';

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
