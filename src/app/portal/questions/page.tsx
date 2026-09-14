import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSchoolSession } from '@/lib/session';
import { listSets } from '@/lib/exam/sets';
import { isSchoolWide } from '@/lib/queries';
import { collectionView } from '@/lib/exam/collection';
import { collectionIsOpen } from '@/lib/exam/authoring-validation';
import { configureCollection, startSet } from './actions';
import './questions.css';

export const dynamic = 'force-dynamic';

const STATUS_LABEL: Record<string, string> = {
  draft: 'In progress',
  submitted: 'Submitted',
  under_review: 'Under review',
  returned: 'Sent back',
  approved: 'Approved',
  published: 'Published',
};

export default async function QuestionSetsPage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const actor = await requireSchoolSession();
  if (!isSchoolWide(actor.role) && actor.role !== 'teacher') notFound();
  const sets = await listSets(actor);
  const data = await collectionView(actor);
  const query = await searchParams;
  const current = data.series.find(s => s.id === data.config.seriesId);
  const available = data.series.filter(s => collectionIsOpen(s) && (s.seriesType === 'practice' || s.id === data.config.seriesId));

  return (
    <div className="question-bank">
      <h1 className="page-title">Question bank</h1>
      {query.error ? <p role="alert">{query.error}</p> : null}
      {query.ok ? <p role="status">{query.ok}</p> : null}
      <p>{current ? `Collection: ${current.title} — ${collectionIsOpen(current) ? 'Open' : 'Outside submission dates'}` : 'Formal question collection is closed.'} Practice remains available in its own collection.</p>
      {isSchoolWide(actor.role) ? <details><summary>Collection window & authoring quotas</summary>
        <form action={configureCollection} className="form-grid">
          <label>Formal collection<select aria-label="Formal collection" name="seriesId" defaultValue={data.config.seriesId ?? ''}><option value="">Close collection</option>
            {data.series.filter(s => s.seriesType !== 'practice' && ['draft', 'open'].includes(s.status)).map(s => <option key={s.id} value={s.id}>{s.title}</option>)}</select></label>
          <label>Objective target<input name="objective" type="number" min="1" max="500" required defaultValue={data.config.objective} /></label>
          <label>Theory target<input name="theory" type="number" min="1" max="100" required defaultValue={data.config.theory} /></label>
          <p className="muted">Set submission dates in <Link href="/portal/exams/new">Exam Office</Link>. Targets apply to new sets; existing requirements are preserved.</p>
          <button type="submit">Save collection</button>
        </form></details> : null}
      <section aria-label="Start a question set"><h2>Start or continue a set</h2>
        {available.length && data.scopes.length ? <form action={startSet} className="form-grid">
          <label>Collection<select aria-label="Collection" name="seriesId" required>{available.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}</select></label>
          <label>Subject & level<select aria-label="Subject & level" name="scope" required>{data.scopes.map(s => <option key={`${s.subjectId}:${s.levelId}:${s.departmentId}`} value={`${s.subjectId}:${s.levelId}:${s.departmentId ?? ''}`}>{s.subject} · {s.level}{s.department ? ` · ${s.department}` : ''}</option>)}</select></label>
          <label>Question type<select aria-label="Question type" name="examType"><option value="objective">Objective</option><option value="theory">Theory (examination only)</option></select></label>
          <button type="submit">Open question set</button>
        </form> : <p className="muted">An open collection and an assigned subject/level are required to start a set.</p>}
      </section>

      {sets.length === 0 ? (
        <p className="muted">
          No question sets yet. Use the collection form above to start one.
        </p>
      ) : (
        <div className="question-table"><table className="tbl">
          <thead>
            <tr>
              <th>Subject</th><th>Level</th><th>Type</th>
              <th>Questions</th><th>Status</th><th />
            </tr>
          </thead>
          <tbody>
            {sets.map((s) => {
              const short = s.questionCount < s.minRequired;

              return (
                <tr key={s.id}>
                  <td>
                    {s.subjectName} <span className="muted mono">{s.subjectCode}</span>
                    {/* Which bank this is. Without it a practice set and the
                        terminal paper for one subject look identical. */}
                    {s.seriesId > 0 ? <span className="tag">assessment</span> : null}
                    {s.waecMode ? <span className="tag">WAEC</span> : null}
                  </td>
                  <td>{s.levelName}{s.departmentName ? ` ${s.departmentName}` : ''}</td>
                  <td>{s.examType === 'objective' ? 'Objective' : 'Theory'}</td>
                  <td className={short ? 'short' : ''}>
                    {s.questionCount} / {s.minRequired}
                  </td>
                  <td><span className={`pill pill--${s.status}`}>{STATUS_LABEL[s.status] ?? s.status}</span></td>
                  <td><Link href={`/portal/questions/${s.id}`}>Open</Link></td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      )}

      {isSchoolWide(actor.role) ? (
        <p className="muted" style={{ marginTop: 18 }}>
          You are seeing every set in the school. A teacher sees only their own.
        </p>
      ) : null}
    </div>
  );
}
