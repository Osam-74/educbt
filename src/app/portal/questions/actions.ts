'use server';
import { redirect } from 'next/navigation';
import { requireSchoolSession } from '@/lib/session';
import { collectionView } from '@/lib/exam/collection';
import { findOrCreateSet, addQuestion, addQuestionsBulk, submitSet, type SetScope } from '@/lib/exam/sets';
import { snapshotSet } from '@/lib/exam/vault';
import type { ParsedRow } from './parsers';

function backToQuestions(params: URLSearchParams, error?: string, ok?: string) {
  if (error) params.set('error', error); else params.delete('error');
  if (ok) params.set('ok', ok); else params.delete('ok');
  redirect(`/portal/questions?${params.toString()}`);
}

function scopeParams(form: FormData) {
  return {
    subjectId: Number(form.get('subjectId')),
    levelId: Number(form.get('levelId')),
    departmentId: form.get('departmentId') ? Number(form.get('departmentId')) : null,
    examType: (form.get('examType') === 'theory' ? 'theory' : 'objective') as 'objective' | 'theory',
    delivery: (form.get('delivery') === 'written' ? 'written' : 'cbt') as 'cbt' | 'written',
    marks: Number(form.get('marks')) || 1,
    method: (['manual', 'paste', 'csv'].includes(String(form.get('method'))) ? form.get('method') : 'manual') as 'manual' | 'paste' | 'csv',
    waecMode: form.get('waecMode') === '1',
  };
}

function toURLParams(s: ReturnType<typeof scopeParams>) {
  return new URLSearchParams({
    subjectId: s.subjectId ? String(s.subjectId) : '',
    levelId: s.levelId ? String(s.levelId) : '',
    departmentId: s.departmentId ? String(s.departmentId) : '',
    examType: s.examType,
    delivery: s.delivery,
    marks: String(s.marks),
    method: s.method,
    waecMode: s.waecMode ? '1' : '',
  });
}

/**
 * The scope selector auto-submits here on every meaningful change. Finds or
 * creates the matching set (when a subject and level are both chosen) and
 * bounces back to the question bank with the resolved scope — including the
 * set id — in the URL, so the entry area below always matches the toggles.
 */
export async function openSet(form: FormData) {
  const actor = await requireSchoolSession();
  const scope = scopeParams(form);
  const params = toURLParams(scope);

  if (!scope.subjectId || !scope.levelId) redirect(`/portal/questions?${params.toString()}`);

  try {
    const data = await collectionView(actor);
    const current = data.series.find((s) => s.id === data.config.seriesId);
    if (!current) throw new Error('The question bank is closed. Ask the exam office to open a submission window.');
    if (!current.termId) throw new Error('The collection needs an academic term.');

    // The series may have already decided the format for every subject —
    // the client hides the toggle in that case, but the choice is enforced
    // here too rather than trusted from the form.
    const forcedDelivery = current.assessmentMode === 'cbt' || current.assessmentMode === 'written'
      ? current.assessmentMode
      : null;

    const setScope: SetScope = {
      sessionId: current.sessionId,
      termId: current.termId,
      subjectId: scope.subjectId,
      levelId: scope.levelId,
      departmentId: scope.departmentId,
      examType: current.seriesType === 'examination' ? scope.examType : 'objective',
      seriesId: current.seriesType === 'examination' ? 0 : current.id,
      waecMode: scope.waecMode,
      deliveryMode: forcedDelivery ?? scope.delivery,
      defaultMarks: scope.marks,
    };
    const set = await findOrCreateSet(actor, setScope);
    params.set('setId', String(set.id));
    params.set('examType', setScope.examType);
  } catch (e) {
    params.set('error', e instanceof Error ? e.message : 'Could not open that scope.');
  }

  redirect(`/portal/questions?${params.toString()}`);
}

export async function saveManualQuestion(form: FormData) {
  const actor = await requireSchoolSession();
  const setId = Number(form.get('setId'));
  const back = (params: URLSearchParams) => backToQuestions(params);
  const returnParams = new URLSearchParams(String(form.get('returnParams') ?? ''));

  const text = String(form.get('text') ?? '').trim();
  if (text.length < 5) { returnParams.set('error', 'Write the question first.'); back(returnParams); return; }

  const options = ['a', 'b', 'c', 'd'].map((k) => ({
    text: String(form.get(`opt_${k}`) ?? '').trim(),
    isCorrect: String(form.get('correct') ?? '') === k,
  }));

  try {
    await addQuestion(actor, setId, {
      text,
      marks: Number(form.get('marks') ?? 1) || 1,
      instructions: String(form.get('instructions') ?? '').trim() || null,
      options,
    });
  } catch (e) {
    returnParams.set('error', e instanceof Error ? e.message : 'That question could not be saved.');
    back(returnParams);
    return;
  }

  returnParams.set('ok', 'Question saved.');
  back(returnParams);
}

export async function bulkAddQuestions(setId: number, examType: 'objective' | 'theory', items: ParsedRow[]) {
  const actor = await requireSchoolSession();
  return addQuestionsBulk(actor, setId, items.map((r) => ({
    text: r.text,
    marks: r.marks,
    markingGuide: r.markingGuide ?? null,
    options: examType === 'objective' ? r.options : undefined,
  })));
}

export async function handInSet(form: FormData) {
  const actor = await requireSchoolSession();
  const setId = Number(form.get('setId'));
  const returnParams = new URLSearchParams(String(form.get('returnParams') ?? ''));

  let result;
  try {
    result = await submitSet(actor, setId);
  } catch (e) {
    returnParams.set('error', e instanceof Error ? e.message : 'That set could not be submitted.');
    backToQuestions(returnParams);
    return;
  }

  if (!result.success) {
    returnParams.set('error', `Not enough questions — ${result.shortfall.join('; ')}.`);
    backToQuestions(returnParams);
    return;
  }

  await snapshotSet(actor.schoolId, setId, 'submitted');
  // Written delivery has nothing in the bank to have "saved" — it is an
  // intent, not a paper — so it gets its own confirmation copy.
  returnParams.set('ok', form.get('written') === '1' ? 'Written examination intent submitted.' : (result.autoApproved ? 'Saved and approved.' : 'Submitted for review.'));
  backToQuestions(returnParams);
}
