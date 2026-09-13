'use server';
import { revalidatePath } from 'next/cache';
import { ZodError } from 'zod';
import { requireSchoolSession } from '@/lib/session';
import { createSession, saveAcademic, saveExamDefaults, saveProfile, saveRanges, saveSignature, saveTerm, selectPeriod, SettingsError } from '@/lib/settings/service';
import { normalizeImage } from '@/lib/settings/images';
import { saveManualRemark } from '@/lib/settings/remarks';

export type SettingsState = { ok: boolean; message: string };
export async function settingsAction(_previous: SettingsState, form: FormData): Promise<SettingsState> {
  const actor = await requireSchoolSession();
  try {
    const kind = String(form.get('kind'));
    const raw = String(form.get('payload') ?? '{}');
    if (raw.length > 50000) throw new SettingsError('The settings submission is too large.');
    const value = JSON.parse(raw);
    const file = form.get('image');
    const image = file instanceof File && file.size ? await normalizeImage(file) : undefined;
    switch (kind) {
      case 'profile': await saveProfile(actor, value, form.get('removeImage') === 'true' ? null : image); break;
      case 'academic': await saveAcademic(actor, value); break;
      case 'period': await selectPeriod(actor, value); break;
      case 'session': await createSession(actor, value); break;
      case 'term': await saveTerm(actor, value); break;
      case 'signature': await saveSignature(actor, value, image); break;
      case 'ranges': await saveRanges(actor, String(form.get('role')), value); break;
      case 'remark': await saveManualRemark(actor, value); break;
      case 'exam': await saveExamDefaults(actor, value); break;
      default: throw new SettingsError('Unknown settings operation.');
    }
    revalidatePath('/portal', 'layout');
    return { ok: true, message: 'Changes saved.' };
  } catch (error) {
    if (error instanceof SettingsError) return { ok: false, message: error.message };
    if (error instanceof ZodError) return { ok: false, message: error.issues.map(i => i.message).slice(0, 3).join(' ') };
    // Academic validation uses plain Error, but never forward database messages.
    if (error instanceof Error && /^(Check assessment|Each grade|Choose unique)/.test(error.message)) return { ok: false, message: error.message };
    return { ok: false, message: 'The changes could not be saved. Your entries are still here. Check them and retry.' };
  }
}
