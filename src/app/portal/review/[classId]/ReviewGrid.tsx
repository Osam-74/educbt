'use client';
import { useActionState, useState } from 'react';
import Link from 'next/link';
import { saveModeration, type ModerationState } from './actions';

type Component = { key: string; label: string; maxScore: number; isExam: boolean };
type Student = { id: number; name: string; admissionNumber: string };
type Subject = { id: number; name: string; code: string };
type Stored = { key: string; caTotal: number; examTotal: number; complete: boolean };
type Score = { key: string; score: number; maxScore: number };

/**
 * The moderation grid — the plugin's school/review.php table ported to
 * React: students down the side, subjects across the top with the code and
 * full name, one editable input per CA component, the exam score shown from
 * the compiled result (it comes from the marked exam paper in this system),
 * and subject totals / grand totals recalculating live on every keystroke.
 */
export function ReviewGrid({ scope, stage, components, students, subjects, stored, scores }: {
  scope: { classId: number; sessionId: number; termId: number };
  stage: string;
  components: Component[];
  students: Student[];
  subjects: Subject[];
  stored: Stored[];
  scores: Score[];
}) {
  const [state, action, pending] = useActionState<ModerationState, FormData>(saveModeration, { ok: false, message: '' });
  const caComponents = components.filter((c) => !c.isExam);
  const examComponent = components.find((c) => c.isExam);

  const storedMap = new Map(stored.map((r) => [r.key, r]));
  const initial = new Map(scores.map((s) => [s.key, s.score]));
  const [values, setValues] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    for (const s of scores) seed[s.key] = String(s.score);
    return seed;
  });

  const editable = ['', 'draft', 'compiled', 'mixed'].includes(stage);
  const locked = !editable;

  const cellTotal = (studentId: number, subjectId: number) => {
    const storedRow = storedMap.get(`${studentId}:${subjectId}`);
    const exam = storedRow ? storedRow.examTotal : 0;
    const ca = caComponents.reduce((sum, c) => {
      const v = parseFloat(values[`${studentId}:${subjectId}:${c.key}`] ?? '');
      return sum + (isNaN(v) ? 0 : v);
    }, 0);
    return { ca, exam, total: ca + exam };
  };

  const studentTotal = (studentId: number) =>
    subjects.reduce((sum, subject) => sum + cellTotal(studentId, subject.id).total, 0);

  const setValue = (key: string, value: string) => setValues((prev) => ({ ...prev, [key]: value }));

  return (
    <form action={action} className="card review-card">
      <input type="hidden" name="classId" value={scope.classId} />
      <input type="hidden" name="sessionId" value={scope.sessionId} />
      <input type="hidden" name="termId" value={scope.termId} />

      <div className="review-table-wrap">
        <table className="review-table">
          <thead>
            <tr>
              <th className="review-sticky">Student</th>
              {subjects.map((subject) => (
                <th key={subject.id} className="review-subject" title={subject.name}>
                  {subject.code || subject.name}
                  <span className="review-subject-name">{subject.name}</span>
                </th>
              ))}
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {students.map((student) => (
              <tr key={student.id}>
                <td className="review-sticky">
                  <strong>{student.name}</strong>
                  <span className="muted review-admission">{student.admissionNumber}</span>
                </td>
                {subjects.map((subject) => (
                  <td key={subject.id} className="review-cell">
                    <div className="review-components">
                      {caComponents.map((c) => {
                        const key = `${student.id}:${subject.id}:${c.key}`;
                        return (
                          <div key={c.key} className="review-comp">
                            <label className="review-comp-label">{c.key}</label>
                            <input
                              type="number"
                              step="0.5"
                              min={0}
                              max={c.maxScore}
                              name={`m:${student.id}:${subject.id}:${c.key}`}
                              value={values[key] ?? ''}
                              disabled={locked || pending}
                              className="review-input"
                              onChange={(e) => setValue(key, e.target.value)}
                            />
                            <span className="review-max">/{c.maxScore}</span>
                          </div>
                        );
                      })}
                      {examComponent && (
                        <div className="review-comp review-comp--exam">
                          <label className="review-comp-label">{examComponent.key}</label>
                          <span className="review-exam-value">
                            {storedMap.get(`${student.id}:${subject.id}`)?.complete
                              ? storedMap.get(`${student.id}:${subject.id}`)!.examTotal
                              : <span className="muted">pending exam</span>}
                            <span className="review-max">/{examComponent.maxScore}</span>
                          </span>
                        </div>
                      )}
                      <div className="review-subject-total">
                        <span className="muted">Subject total: </span>
                        <strong className="review-total">{cellTotal(student.id, subject.id).total.toFixed(1)}</strong>
                      </div>
                    </div>
                  </td>
                ))}
                <td><strong className="review-grand">{studentTotal(student.id).toFixed(1)}</strong></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="review-actions-row">
        <button type="submit" className="primary" disabled={locked || pending || caComponents.length === 0}>
          {pending ? 'Saving…' : 'Save & Recompile'}
        </button>
        <Link className="btn-plain" href="/portal/results">Cancel</Link>
      </div>

      {caComponents.length === 0 && (
        <p className="note">No assessment components are configured. Ask the principal to complete academic settings first.</p>
      )}
      {state.message && <p role={state.ok ? 'status' : 'alert'} className={state.ok ? 'note' : 'error'}>{state.message}</p>}
    </form>
  );
}
