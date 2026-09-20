'use client';
/**
 * The "Open a new assessment window (CA)" form, pulled out of page.tsx into
 * its own client component for one reason: Assessment mode needs to hide
 * fields that mean nothing once every subject in the window is Written —
 * there is no CBT sitting to time or pool questions for, so Questions per
 * student and Duration (and the question-submission window, which exists to
 * collect CBT questions from teachers) would just be confusing dead inputs.
 * The server action itself (openCaWindow, still owned by page.tsx) and its
 * validation are untouched — hidden fields carry the same defaults the
 * visible inputs used to, so a Written window still gets a valid row.
 */
import { useState } from 'react';

const DEFAULT_QUESTIONS_PER_STUDENT = 20;
const DEFAULT_DURATION_MINUTES = 30;

export default function CaWindowForm({
  caSlots,
  action,
}: {
  caSlots: { key: string; label: string }[];
  action: (formData: FormData) => void;
}) {
  const [mode, setMode] = useState<'mixed' | 'cbt' | 'written'>('mixed');
  const written = mode === 'written';

  return (
    <form action={action} className="eo-mini-form" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <label style={{ flex: 1, minWidth: 220 }}>
          Counts towards
          <select name="caComponentKey" required>
            {caSlots.map((c) => (
              <option key={c.key} value={c.key}>{c.label}</option>
            ))}
          </select>
        </label>
        <label style={{ flex: 1, minWidth: 220 }}>
          Name (optional)
          <input name="title" maxLength={191} placeholder="Defaults to the slot's name" />
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
          <input type="hidden" name="questionsPerStudent" value={DEFAULT_QUESTIONS_PER_STUDENT} />
          <input type="hidden" name="durationMinutes" value={DEFAULT_DURATION_MINUTES} />
          <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
            Every subject in this window is on paper — there is nothing to time or pool questions for, so the question window and per-student/duration settings are skipped.
          </p>
        </>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <label style={{ flex: 1, minWidth: 220 }}>
              Question window opens
              <input name="questionsOpenFrom" type="date" />
            </label>
            <label style={{ flex: 1, minWidth: 220 }}>
              Question window closes
              <input name="questionsOpenTo" type="date" />
            </label>
          </div>

          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <label style={{ flex: 1, minWidth: 220 }}>
              Questions per student
              <input name="questionsPerStudent" type="number" min="1" max="200" defaultValue={DEFAULT_QUESTIONS_PER_STUDENT} required />
            </label>
            <label style={{ flex: 1, minWidth: 220 }}>
              Duration (minutes)
              <input name="durationMinutes" type="number" min="5" max="300" placeholder="e.g. 30" required />
            </label>
          </div>
        </>
      )}

      <button type="submit" className="sd-action" style={{ alignSelf: 'flex-start' }}>Open assessment window</button>
    </form>
  );
}
