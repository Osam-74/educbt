'use server';
import { redirect } from 'next/navigation';
import { requireSchoolSession } from '@/lib/session';
import { collectionView, saveCollection } from '@/lib/exam/collection';
import { findOrCreateSet } from '@/lib/exam/sets';

export async function configureCollection(form: FormData) {
  const actor = await requireSchoolSession();
  try { await saveCollection(actor, { seriesId: form.get('seriesId') || null, objective: form.get('objective'), theory: form.get('theory') }); }
  catch (error) { redirect('/portal/questions?error=' + encodeURIComponent(error instanceof Error ? error.message : 'Could not save collection.')); }
  redirect('/portal/questions?ok=Collection%20saved');
}
export async function startSet(form: FormData) {
  const actor = await requireSchoolSession();
  let id: number;
  try {
    const data = await collectionView(actor);
    const scope = data.scopes.find(s => `${s.subjectId}:${s.levelId}:${s.departmentId ?? ''}` === form.get('scope'));
    const series = data.series.find(s => s.id === Number(form.get('seriesId')));
    if (!scope || !series) throw new Error('Choose an assigned scope and collection.');
    if (!series.termId) throw new Error('The collection needs an academic term.');
    const type = form.get('examType');
    if (type !== 'objective' && type !== 'theory') throw new Error('Choose objective or theory.');
    const set = await findOrCreateSet(actor, { sessionId: series.sessionId, termId: series.termId,
      subjectId: scope.subjectId!, levelId: scope.levelId, departmentId: scope.departmentId,
      seriesId: series.seriesType === 'examination' ? 0 : series.id, examType: type, waecMode: false });
    id = set.id;
  } catch (error) { redirect('/portal/questions?error=' + encodeURIComponent(error instanceof Error ? error.message : 'Could not start set.')); }
  redirect(`/portal/questions/${id}`);
}
