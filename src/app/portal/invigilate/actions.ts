'use server';

import { redirect } from 'next/navigation';
import { requireSchoolSession } from '@/lib/session';
import { grantReattempt } from '@/lib/exam/sessions';

export async function grantReattemptAction(formData: FormData) {
  const actor = await requireSchoolSession();
  const attemptId = Number(formData.get('attemptId'));
  const reason = String(formData.get('reason') ?? '');
  const back = String(formData.get('back') ?? '/portal/invigilate');

  const result = await grantReattempt(actor, attemptId, reason);

  const sep = back.includes('?') ? '&' : '?';
  redirect(result.ok ? `${back}${sep}ok=1` : `${back}${sep}error=${encodeURIComponent(result.error ?? 'Failed.')}`);
}
