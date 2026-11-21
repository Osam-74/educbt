'use server';

import { redirect } from 'next/navigation';
import { requireSchoolSession } from '@/lib/session';
import { assignToArm } from '@/lib/people/arm-assignment';

/**
 * Apply an arm split. The server decides who may move whom (assignToArm checks the actor's classes on both ends);
 * this only reads the form and reports the outcome. A student who is refused is named with the reason, not dropped.
 */
export async function assignArms(form: FormData) {
  const actor = await requireSchoolSession();
  const back = new URLSearchParams(String(form.get('returnParams') ?? ''));
  back.delete('armOk'); back.delete('armError'); back.delete('armSkipped');
  const ids = form.getAll('studentIds').map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const toClassId = Number(form.get('toClassId'));

  try {
    const result = await assignToArm(actor, ids, toClassId);
    if (!result.success) back.set('armError', result.error);
    else {
      back.set('armOk', `${result.moved} student${result.moved === 1 ? '' : 's'} moved.`);
      if (result.skipped.length) back.set('armSkipped', JSON.stringify(result.skipped.slice(0, 50).map((s) => ({ n: s.name, r: s.reason }))));
    }
  } catch (e) {
    back.set('armError', e instanceof Error ? e.message : 'The students could not be moved.');
  }
  // Always back to the Students page: a value from the form is never used as a redirect target.
  redirect(`/portal/students?${back.toString()}`);
}
