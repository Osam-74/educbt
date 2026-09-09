'use server';
import { revalidatePath } from 'next/cache';
import { requireSchoolSession } from '@/lib/session';
import { resultScopeSchema, resultStateSchema } from '@/lib/results/config';
import { compileClassResults, transitionClassResults, ResultError } from '@/lib/results/workflow';
export type ActionState = { ok: boolean; message: string };
export async function resultAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireSchoolSession();
  const value = (key: string) => form.getAll(key).length === 1 && typeof form.get(key) === 'string' ? String(form.get(key)) : '';
  const parsed = resultScopeSchema.safeParse({ classId: Number(value('classId')), sessionId: Number(value('sessionId')), termId: Number(value('termId')) });
  if (!parsed.success) return { ok: false, message: 'Choose a valid class, session and term.' };
  try {
    if (value('operation') === 'compile') {
      const result = await compileClassResults(actor, parsed.data);
      revalidatePath('/portal/results'); revalidatePath('/portal/broadsheet'); revalidatePath('/portal/reports', 'layout');
      return { ok: true, message: `${result.compiled} subject results compiled. Inspect the review table before sign-off.` };
    }
    const to = resultStateSchema.safeParse(value('operation'));
    if (!to.success) return { ok: false, message: 'Choose a valid result action.' };
    const result = await transitionClassResults(actor, parsed.data, to.data, value('reason'));
    revalidatePath('/portal/results'); revalidatePath('/portal/ca'); revalidatePath('/portal/broadsheet'); revalidatePath('/portal/reports', 'layout');
    return { ok: true, message: `${result.moved} subject results moved to ${to.data}.` };
  } catch (error) {
    return { ok: false, message: error instanceof ResultError ? error.message : 'Results could not be updated. Reload to check their stage before retrying.' };
  }
}
