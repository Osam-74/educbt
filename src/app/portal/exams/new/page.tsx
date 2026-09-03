import { redirect } from 'next/navigation';
import { asc, eq } from 'drizzle-orm';
import { requireSchoolSession, requireRole, SCHOOL_WIDE } from '@/lib/session';
import { createSeries } from '@/lib/exam/compose';
import { forSchool, schema } from '@/db';

export const dynamic = 'force-dynamic';

export default async function NewExamPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const query = await searchParams;
  const actor = await requireSchoolSession();
  requireRole(actor, SCHOOL_WIDE);

  const { sessions, terms } = await forSchool(actor.schoolId, async (tx) => ({
    sessions: await tx
      .select({ id: schema.academicSessions.id, title: schema.academicSessions.title, isCurrent: schema.academicSessions.isCurrent })
      .from(schema.academicSessions)
      .where(eq(schema.academicSessions.schoolId, actor.schoolId))
      .orderBy(asc(schema.academicSessions.id)),
    terms: await tx
      .select({
        id: schema.terms.id,
        sessionId: schema.terms.sessionId,
        title: schema.terms.title,
        isCurrent: schema.terms.isCurrent,
      })
      .from(schema.terms)
      .where(eq(schema.terms.schoolId, actor.schoolId))
      .orderBy(asc(schema.terms.position)),
  }));

  async function create(formData: FormData) {
    'use server';

    const inner = await requireSchoolSession();
    requireRole(inner, SCHOOL_WIDE);

    let destination: string;

    try {
      const series = await createSeries(inner, {
        title: String(formData.get('title') ?? ''),
        seriesType: String(formData.get('seriesType') ?? ''),
        sessionId: String(formData.get('sessionId') ?? ''),
        termId: String(formData.get('termId') ?? ''),
        questionsPerStudent: String(formData.get('questionsPerStudent') ?? ''),
        durationMinutes: String(formData.get('durationMinutes') ?? ''),
        questionsOpenFrom: formData.get('questionsOpenFrom') || null,
        questionsOpenTo: formData.get('questionsOpenTo') || null,
      });

      destination = `/portal/exams/${Number(series.id)}`;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'The examination could not be created.';
      destination = `/portal/exams/new?error=${encodeURIComponent(message)}`;
    }

    // Outside the try/catch: redirect() throws, and catching it would turn the
    // success path into the error page.
    redirect(destination);
  }

  const defaultSession = sessions.find((s) => s.isCurrent) ?? sessions[0];
  const defaultTerm = terms.find((t) => t.isCurrent && t.sessionId === defaultSession?.id) ?? terms[0];

  return (
    <>
      <h1 className="page-title">Create examination</h1>
      <p className="muted">
        This sets up the container. Teachers submit their questions into it during
        the question window; the papers themselves are composed in the next step,
        from approved questions only.
      </p>

      {query.error ? <p className="error">{query.error}</p> : null}

      <form action={create} className="card" style={{ maxWidth: 640 }}>
        <div style={{ marginBottom: 16 }}>
          <label htmlFor="title">Name</label>
          <input id="title" name="title" required maxLength={191}
                 placeholder="e.g. First Term Examination 2026/2027" />
        </div>

        <div style={{ marginBottom: 16 }}>
          <label htmlFor="seriesType">Type</label>
          <select id="seriesType" name="seriesType" defaultValue="examination" required>
            <option value="examination">Examination — terminal, reviewed, timetabled</option>
            <option value="ca_test">CA Test — continuous assessment, timetabled</option>
            <option value="practice">Practice — for revision, always available</option>
          </select>
        </div>

        <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <label htmlFor="sessionId">Academic session</label>
            <select id="sessionId" name="sessionId" defaultValue={defaultSession?.id} required>
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>{s.title}</option>
              ))}
            </select>
          </div>
          <div style={{ flex: 1, minWidth: 220 }}>
            <label htmlFor="termId">Term</label>
            <select id="termId" name="termId" defaultValue={defaultTerm?.id} required>
              {terms.map((t) => (
                <option key={t.id} value={t.id}>{t.title}</option>
              ))}
            </select>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <label htmlFor="questionsPerStudent">Questions per paper</label>
            <input id="questionsPerStudent" name="questionsPerStudent" type="number"
                   min="1" max="200" defaultValue={40} required />
            <p className="muted" style={{ fontSize: 12.5, margin: '4px 0 0' }}>
              Questions required is the number of questions each student will answer
              in the objective paper.
            </p>
          </div>
          <div style={{ flex: 1, minWidth: 220 }}>
            <label htmlFor="durationMinutes">Duration (minutes)</label>
            <input id="durationMinutes" name="durationMinutes" type="number"
                   min="5" max="300" defaultValue={60} required />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 16, marginBottom: 20, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <label htmlFor="questionsOpenFrom">Teachers submit questions from (optional)</label>
            <input id="questionsOpenFrom" name="questionsOpenFrom" type="date" />
          </div>
          <div style={{ flex: 1, minWidth: 220 }}>
            <label htmlFor="questionsOpenTo">Teachers submit questions until (optional)</label>
            <input id="questionsOpenTo" name="questionsOpenTo" type="date" />
          </div>
        </div>

        <p className="muted" style={{ fontSize: 12.5 }}>
          The sitting dates are not set here. They are set on the timetable once the
          papers exist.
        </p>

        <button type="submit">Create examination</button>
      </form>
    </>
  );
}
