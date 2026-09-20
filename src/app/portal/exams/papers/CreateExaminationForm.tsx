'use client';
/**
 * The "Create examination" form, pulled out of page.tsx for the same reason
 * as CaWindowForm: Assessment mode moves right after Term (the fields that
 * identify WHICH sitting this is), and once Written is chosen there is no
 * CBT paper to time, pool questions into, or open a submission window for —
 * so Questions per paper, Duration and the teacher question-submission
 * window all hide. The server action (create, owned by page.tsx) and its
 * validation are untouched — hidden fields carry the same defaults the
 * visible inputs used to, so a Written examination still gets a valid row.
 */
import { useState } from 'react';

const DEFAULT_QUESTIONS_PER_PAPER = 40;
const DEFAULT_DURATION_MINUTES = 60;

export default function CreateExaminationForm({
  sessions,
  terms,
  defaultSessionId,
  defaultTermId,
  action,
}: {
  sessions: { id: number | string; title: string }[];
  terms: { id: number | string; title: string }[];
  defaultSessionId?: number | string;
  defaultTermId?: number | string;
  action: (formData: FormData) => void;
}) {
  const [mode, setMode] = useState<'mixed' | 'cbt' | 'written'>('mixed');
  const written = mode === 'written';

  return (
    <form action={action} className="eo-mini-form" style={{ flexDirection: 'column', alignItems: 'stretch', padding: '0 22px 20px' }}>
      <label>
        Name
        <input name="title" required maxLength={191} placeholder="e.g. First Term Examination 2026/2027" />
      </label>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <label style={{ flex: 1, minWidth: 220 }}>
          Type
          <select name="seriesType" defaultValue="examination" required>
            <option value="examination">Examination — terminal, reviewed, timetabled</option>
            <option value="ca_test">CA Test — continuous assessment, timetabled</option>
            <option value="practice">Practice — for revision, always available</option>
          </select>
        </label>
        <label style={{ flex: 1, minWidth: 220 }}>
          Academic session
          <select name="sessionId" defaultValue={defaultSessionId} required>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>{s.title}</option>
            ))}
          </select>
        </label>
        <label style={{ flex: 1, minWidth: 220 }}>
          Term
          <select name="termId" defaultValue={defaultTermId} required>
            {terms.map((t) => (
              <option key={t.id} value={t.id}>{t.title}</option>
            ))}
          </select>
        </label>
        <label style={{ flex: 1, minWidth: 220 }}>
          Assessment mode
          <select name="assessmentMode" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            <option value="mixed">Mixed — each teacher chooses CBT or Written</option>
            <option value="cbt">CBT — every subject is a CBT test</option>
            <option value="written">Written — every subject is on paper</option>
          </select>
        </label>
      </div>

      {written ? (
        <>
          <input type="hidden" name="questionsPerStudent" value={DEFAULT_QUESTIONS_PER_PAPER} />
          <input type="hidden" name="durationMinutes" value={DEFAULT_DURATION_MINUTES} />
          <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
            Every subject in this examination is on paper — there is nothing to time or pool questions for, so questions-per-paper, duration and the teacher question-submission window are skipped.
          </p>
        </>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <label style={{ flex: 1, minWidth: 220 }}>
              Questions per paper
              <input name="questionsPerStudent" type="number" min="1" max="200" defaultValue={DEFAULT_QUESTIONS_PER_PAPER} required />
            </label>
            <label style={{ flex: 1, minWidth: 220 }}>
              Duration (minutes)
              <input name="durationMinutes" type="number" min="5" max="300" placeholder="e.g. 60" required />
            </label>
          </div>

          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <label style={{ flex: 1, minWidth: 220 }}>
              Teachers submit questions from (optional)
              <input name="questionsOpenFrom" type="date" />
            </label>
            <label style={{ flex: 1, minWidth: 220 }}>
              Teachers submit questions until (optional)
              <input name="questionsOpenTo" type="date" />
            </label>
          </div>
        </>
      )}

      <p className="muted" style={{ fontSize: 12.5, margin: '0 0 6px' }}>
        The sitting dates are not set here. They are set on the timetable once the papers exist.
      </p>

      <button type="submit" className="sd-action" style={{ alignSelf: 'flex-start' }}>Create examination</button>
    </form>
  );
}
