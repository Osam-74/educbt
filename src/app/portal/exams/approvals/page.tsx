import Link from 'next/link';
import { redirect } from 'next/navigation';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { requireSchoolSession, requireRole, SCHOOL_WIDE } from '@/lib/session';
import { forSchool, schema } from '@/db';
import { reviewSet } from '@/lib/exam/sets';
import { snapshotSet } from '@/lib/exam/vault';

export const dynamic = 'force-dynamic';

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const query = await searchParams;
  const actor = await requireSchoolSession();

  // Server-side. The nav link is convenience; this is what protects the route.
  requireRole(actor, SCHOOL_WIDE);

  const pending = await forSchool(actor.schoolId, async (tx) =>
    tx
      .select({
        id: schema.questionSets.id,
        examType: schema.questionSets.examType,
        status: schema.questionSets.status,
        submittedAt: schema.questionSets.submittedAt,
        subjectName: schema.subjects.name,
        levelName: schema.classLevels.name,
        teacherFirst: schema.staff.firstName,
        teacherLast: schema.staff.lastName,
        questionCount: sql<number>`(
          SELECT count(*) FROM ${schema.questions} q
          WHERE q.question_set_id = ${schema.questionSets.id} AND q.status = 'active'
        )`.mapWith(Number),
      })
      .from(schema.questionSets)
      .innerJoin(schema.subjects, eq(schema.subjects.id, schema.questionSets.subjectId))
      .innerJoin(schema.classLevels, eq(schema.classLevels.id, schema.questionSets.levelId))
      .leftJoin(schema.staff, eq(schema.staff.id, schema.questionSets.teacherId))
      .where(and(
        eq(schema.questionSets.schoolId, actor.schoolId),
        inArray(schema.questionSets.status, ['submitted', 'under_review']),
      )),
  );

  async function decide(formData: FormData) {
    'use server';

    const inner = await requireSchoolSession();
    const setId = Number(formData.get('setId'));
    const decision = String(formData.get('decision')) as 'approve' | 'return';
    const comment = String(formData.get('comment') ?? '').trim();

    try {
      await reviewSet(inner, setId, decision, comment);
    } catch (e) {
      redirect(`/portal/review?error=${encodeURIComponent(e instanceof Error ? e.message : 'Failed.')}`);
    }

    // Snapshot on approval: this is the version that will actually be sat.
    if (decision === 'approve') await snapshotSet(inner.schoolId, setId, 'approved');

    redirect(`/portal/review?ok=${decision}`);
  }

  return (
    <>
      <h1 className="page-title">Question review</h1>

      {query.error ? <p className="error">{query.error}</p> : null}
      {query.ok === 'approve' ? <p className="ok">Set approved.</p> : null}
      {query.ok === 'return' ? <p className="ok">Sent back to the teacher.</p> : null}

      {pending.length === 0 ? (
        <p className="muted">Nothing waiting for review.</p>
      ) : (
        pending.map((s) => (
          <section className="card" key={s.id}>
            <h2>
              {s.subjectName} — {s.levelName}
              <span className="muted" style={{ fontWeight: 400, fontSize: 14 }}>
                {' '}({s.examType === 'objective' ? 'Objective' : 'Theory'}, {s.questionCount} questions)
              </span>
            </h2>
            <p className="muted">
              Submitted by {s.teacherFirst ?? '—'} {s.teacherLast ?? ''}
              {s.submittedAt ? ` on ${s.submittedAt.toISOString().slice(0, 10)}` : ''}
              {' · '}
              <Link href={`/portal/questions/${s.id}`}>Read the questions</Link>
            </p>

            <form action={decide}>
              <input type="hidden" name="setId" value={s.id} />
              <label htmlFor={`c_${s.id}`}>Comment</label>
              <input id={`c_${s.id}`} name="comment" type="text"
                     placeholder="Required when sending back — at least 10 characters" />
              <div style={{ display: 'flex', gap: 10 }}>
                <button type="submit" name="decision" value="approve">Approve</button>
                <button type="submit" name="decision" value="return" className="danger">
                  Send back
                </button>
              </div>
            </form>
          </section>
        ))
      )}

      <p className="muted" style={{ marginTop: 18 }}>
        Sending a set back requires a reason. A rejection without one is one the
        teacher cannot act on.
      </p>
    </>
  );
}
