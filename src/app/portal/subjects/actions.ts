'use server';

import { revalidatePath } from 'next/cache';
import { requireSchoolSession } from '@/lib/session';
import { SubjectError, saveSubject, deleteSubject, refreshStandardSubjects } from '@/lib/subjects/service';

export type ActionState = { ok: boolean; message: string };

/**
 * One dispatcher for every subject mutation on the page. The capability check
 * lives in the service (defense in depth); this layer only translates forms
 * and revalidates — the same pattern as the staff page.
 */
export async function subjectAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireSchoolSession();
  const value = (key: string) => {
    const v = form.get(key);
    return typeof v === 'string' ? v : '';
  };
  const operation = value('operation');

  try {
    if (operation === 'save') {
      const subject = await saveSubject(actor, {
        subjectId: Number(value('subjectId')) || undefined,
        name: value('name'),
        code: value('code'),
        stage: value('stage') || 'both',
        departmentId: Number(value('departmentId')) || undefined,
        isCompulsory: value('is_compulsory') === '1',
      });

      revalidatePath('/portal/subjects');
      // Inline edit and creation share this handler, so the message covers both.
      return value('subjectId')
        ? { ok: true, message: `${subject.name} updated with code ${subject.code}.` }
        : { ok: true, message: `${subject.name} added with code ${subject.code}.` };
    }

    if (operation === 'delete') {
      const result = await deleteSubject(actor, Number(value('subjectId')));

      revalidatePath('/portal/subjects');
      return result.retired
        ? {
            ok: true,
            message: `${result.name} retired — it already carries ${result.records} record(s), so existing report cards stay readable.`,
          }
        : { ok: true, message: `${result.name} removed.` };
    }

    if (operation === 'refresh') {
      const result = await refreshStandardSubjects(actor);

      revalidatePath('/portal/subjects');
      return {
        ok: true,
        message: `Standard list loaded: ${result.added} added, ${result.retired} retired, ${result.removed} removed.`,
      };
    }

    return { ok: false, message: 'Unknown request.' };
  } catch (error) {
    if (error instanceof SubjectError) return { ok: false, message: error.message };
    console.error('subjectAction', error);
    return { ok: false, message: 'The subject could not be saved. Please try again.' };
  }
}
