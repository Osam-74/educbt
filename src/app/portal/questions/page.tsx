import Link from 'next/link';
import { eq, and } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import { requireSchoolSession } from '@/lib/session';
import { isSchoolWide } from '@/lib/queries';
import { forSchool, schema } from '@/db';
import { collectionView } from '@/lib/exam/collection';
import { setWithQuestions } from '@/lib/exam/sets';
import { caComponents } from '@/lib/ca/validation';
import { openSet } from './actions';
import BankFields from './BankFields';
import ManualEntry from './ManualEntry';
import BulkImport from './BulkImport';
import WrittenIntent from './WrittenIntent';
import './questions.css';

export const dynamic = 'force-dynamic';

type Query = {
  subjectId?: string; levelId?: string; departmentId?: string;
  examType?: string; delivery?: string; marks?: string; method?: string; waecMode?: string;
  setId?: string; error?: string; ok?: string;
};

export default async function QuestionBankPage({ searchParams }: { searchParams: Promise<Query> }) {
  const actor = await requireSchoolSession();
  if (!isSchoolWide(actor.role) && actor.role !== 'teacher') notFound();

  const q = await searchParams;
  const data = await collectionView(actor);
  const current = data.series.find((s) => s.id === data.config.seriesId);

  const subjectId = Number(q.subjectId) || 0;
  const levelId = Number(q.levelId) || 0;
  const departmentId = q.departmentId ? Number(q.departmentId) : null;
  const examType = q.examType === 'theory' ? 'theory' : 'objective';
  const delivery = q.delivery === 'written' ? 'written' : 'cbt';
  const marks = Number(q.marks) || 1;
  const method = (['manual', 'paste', 'csv'] as const).includes(q.method as never) ? (q.method as 'manual' | 'paste' | 'csv') : 'manual';
  const waecMode = q.waecMode === '1';
  const setId = Number(q.setId) || 0;

  const theoryAllowed = current?.seriesType === 'examination';
  const lockedDelivery: 'cbt' | 'written' | null =
    current?.assessmentMode === 'cbt' ? 'cbt' : current?.assessmentMode === 'written' ? 'written' : null;
  const componentLabel = current?.caComponentKey
    ? caComponents(data.settings as Record<string, unknown>).find((c) => c.key === current.caComponentKey)?.label ?? current.caComponentKey
    : '';

  const subject = data.scopes.find((s) => s.subjectId === subjectId)?.subject ?? '';
  const level = data.scopes.find((s) => s.levelId === levelId)?.level ?? '';

  const returnParams = new URLSearchParams({
    subjectId: subjectId ? String(subjectId) : '', levelId: levelId ? String(levelId) : '',
    departmentId: departmentId ? String(departmentId) : '', examType, delivery, marks: String(marks), method,
    waecMode: waecMode ? '1' : '', setId: setId ? String(setId) : '',
  }).toString();
  // Method now switches locally without a round-trip (see BankFields), so the
  // URL's own `method` can lag behind what's on screen. ManualEntry's save
  // action redirects back using this string — pin it to 'manual' explicitly
  // so saving a question always lands back on the manual panel, regardless
  // of whatever method the URL last carried.
  const manualReturnParams = new URLSearchParams(returnParams);
  manualReturnParams.set('method', 'manual');
  const manualReturnParamsStr = manualReturnParams.toString();

  const loaded = setId ? await setWithQuestions(actor, setId) : null;
  const periodTitle = current ? await forSchool(actor.schoolId, async (tx) => {
    const [session] = await tx.select({ title: schema.academicSessions.title }).from(schema.academicSessions)
      .where(and(eq(schema.academicSessions.id, current.sessionId), eq(schema.academicSessions.schoolId, actor.schoolId)));
    const [term] = current.termId ? await tx.select({ title: schema.terms.title }).from(schema.terms)
      .where(and(eq(schema.terms.id, current.termId), eq(schema.terms.schoolId, actor.schoolId))) : [];
    return [session?.title, term?.title].filter(Boolean).join(' · ');
  }) : '';

  return (
    <div className="question-bank">
      <h1 className="page-title">Question Bank</h1>
      {q.error ? <p role="alert" className="error">{q.error}</p> : null}
      {q.ok ? <p role="status" className="ok">{q.ok}</p> : null}

      <section className="qs-banner" aria-label="Writing for">
        {!current ? (
          <div className="qs-banner__closed">
            <h2>Closed</h2>
            <p className="muted">You&rsquo;ll be notified when it&rsquo;s open.</p>
          </div>
        ) : (
          <>
            <strong>Writing for: {current.title}</strong>
            <span className="qs-banner__detail">
              {current.seriesType === 'examination' ? (
                'Terminal examination. Objective and theory are submitted together as one paper, and go to the examination officer for review.'
              ) : current.seriesType === 'practice' ? (
                'Practice questions. No approval, no timetable — they are available to students as soon as you save them, and the marks do not count towards results.'
              ) : (
                <>
                  Objective questions only.
                  {current.questionsPerStudent ? ` Each student answers ${current.questionsPerStudent} in ${current.durationMinutes} minutes.` : ''}
                  {current.questionsOpenTo ? ` Closes ${new Date(current.questionsOpenTo).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}.` : ''}
                  {componentLabel ? ` Marks count towards ${componentLabel}.` : ''}
                  {' '}These questions stay in the bank and can be reused in the terminal paper.
                </>
              )}
            </span>
          </>
        )}
      </section>

      {current ? (
        <section className="qs-scope card">
          <div className="qs-session-row">
            <span className="qs-label">Session / Term</span>
            <span>{periodTitle || 'No session set'}</span>
          </div>
          <BankFields
            scopes={data.scopes.filter((s): s is typeof s & { subjectId: number } => s.subjectId !== null)}
            subjectId={subjectId} levelId={levelId} departmentId={departmentId}
            examType={examType} delivery={delivery} marks={marks} method={method} waecMode={waecMode}
            theoryAllowed={!!theoryAllowed} lockedDelivery={lockedDelivery} action={openSet}
            opening={<p className="muted">Opening…</p>}
            writtenIntent={loaded ? (
              <WrittenIntent subject={subject} level={level} setId={loaded.set.id} returnParams={returnParams}
                already={loaded.set.status !== 'draft'} />
            ) : null}
            manualEntry={loaded ? (
              <ManualEntry set={loaded.set as never} questions={loaded.questions as never} returnParams={manualReturnParamsStr} />
            ) : null}
            pasteImport={loaded ? (
              <BulkImport mode="paste" examType={examType} defaultMarks={Number(loaded.set.defaultMarks) || marks} setId={loaded.set.id} />
            ) : null}
            csvImport={loaded ? (
              <BulkImport mode="csv" examType={examType} defaultMarks={Number(loaded.set.defaultMarks) || marks} setId={loaded.set.id} />
            ) : null}
          />
        </section>
      ) : null}

      {isSchoolWide(actor.role) ? (
        <p className="muted" style={{ marginTop: 18 }}>
          You are seeing your own scopes only above. Every teacher&rsquo;s submissions are reviewed from{' '}
          <Link href="/portal/exams/approvals">Approve Questions</Link>.
        </p>
      ) : null}
    </div>
  );
}
