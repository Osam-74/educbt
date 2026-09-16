'use server';

import { revalidatePath } from 'next/cache';
import { requireSchoolSession } from '@/lib/session';
import { ClassError, createClasses, removeClass, updateClass } from '@/lib/school/classes';

export type ActionState = { ok: boolean; message: string };

/**
 * One dispatcher for every class mutation on the page — the same pattern as
 * subjects and staff. The capability check lives in the service (defense in
 * depth); this layer only translates forms and revalidates.
 */
export async function classAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireSchoolSession();
  const value = (key: string) => {
    const v = form.get(key);
    return typeof v === 'string' ? v : '';
  };
  const operation = value('operation');

  try {
    if (operation === 'create') {
      const result = await createClasses(actor, {
        levelId: Number(value('levelId')) || 0,
        arms: value('arms'),
        departmentId: Number(value('departmentId')) || undefined,
      });

      revalidatePath('/portal/classes');
      // Legacy create_classes fails the whole action when nothing was created,
      // and reports the per-arm reasons for the skips either way.
      if (result.created.length === 0) {
        return { ok: false, message: `No classes were created. ${result.skipped.join(' ')}`.trim() };
      }
      const skipped = result.skipped.length ? ` ${result.skipped.join(' ')}` : '';
      return {
        ok: true,
        message: `${result.created.length} class${result.created.length === 1 ? '' : 'es'} created (${result.created.join(', ')}).${skipped}`,
      };
    }

    if (operation === 'update') {
      const result = await updateClass(actor, {
        classId: Number(value('classId')) || 0,
        arm: value('arm'),
        capacity: Number(value('capacity')) || 0,
        departmentId: Number(value('departmentId')) || undefined,
      });

      revalidatePath('/portal/classes');
      return { ok: true, message: `${result.displayName} updated.` };
    }

    if (operation === 'remove') {
      const result = await removeClass(actor, Number(value('classId')) || 0);

      revalidatePath('/portal/classes');
      return { ok: true, message: `${result.name} removed.` };
    }

    return { ok: false, message: 'Unknown operation.' };
  } catch (error) {
    if (error instanceof ClassError) return { ok: false, message: error.message };
    throw error; // unexpected failures surface as 500s, not silent red text
  }
}
