'use client';
/**
 * The scope selector for the Question Bank (legacy parity: the sticky
 * "Region A" scope selector in templates/portal/exams/questions.php). A
 * teacher picks Subject, Class Level, Exam Type, Delivery Mode, Default
 * Marks and (when eligible) WAEC Standard here. Every one of those fields
 * changes WHICH question set is in play, so changing them re-submits the
 * form immediately (matching the legacy's live reload) via the server
 * action passed in as `action` — which finds-or-creates the set and
 * redirects back here with the new scope in the URL, so a refresh or a
 * shared link reproduces exactly what was on screen. Default Marks commits
 * on blur, not every keystroke.
 *
 * Method (Manual Entry / Paste / CSV) is different: it only changes which
 * *entry UI* is shown for the SAME already-loaded set, so it never touches
 * the server — the caller renders all three entry panels once and this
 * component just shows whichever one matches the local `method` state,
 * switching instantly on click (this is the fix for questions being
 * reported as "just loading on every click": that select used to trigger
 * the same full round-trip as the other fields for no reason).
 */
import { useEffect, useRef, useState } from 'react';

export type BankScope = {
  subjectId: number;
  levelId: number;
  departmentId: number | null;
  subject: string;
  level: string;
  department: string | null;
};

export default function BankFields({
  scopes,
  subjectId: initialSubjectId,
  levelId: initialLevelId,
  departmentId: initialDepartmentId,
  examType: initialExamType,
  delivery: initialDelivery,
  marks: initialMarks,
  method: initialMethod,
  waecMode: initialWaecMode,
  theoryAllowed,
  lockedDelivery,
  action,
  manualEntry,
  pasteImport,
  csvImport,
  writtenIntent,
  opening,
}: {
  scopes: BankScope[];
  subjectId: number;
  levelId: number;
  departmentId: number | null;
  examType: 'objective' | 'theory';
  delivery: 'cbt' | 'written';
  marks: number;
  method: 'manual' | 'paste' | 'csv';
  waecMode: boolean;
  theoryAllowed: boolean;
  /** When set, this series has already decided the format for every subject
   * — the Delivery Mode toggle is hidden and forced to this value. Null under
   * 'mixed', where each subject-teacher still chooses. */
  lockedDelivery: 'cbt' | 'written' | null;
  action: (formData: FormData) => void;
  /** Pre-rendered entry panels for the set already loaded at this scope — all
   * three (manual/paste/csv) are handed in up front so switching Method is a
   * local, instant swap with no server round-trip. Null while no set is
   * resolved yet (e.g. still "Opening…" right after a scope change). */
  manualEntry: React.ReactNode;
  pasteImport: React.ReactNode;
  csvImport: React.ReactNode;
  writtenIntent: React.ReactNode;
  /** Shown while a scope change's server round-trip is still resolving the
   * matching set — Method switching never triggers this. */
  opening: React.ReactNode;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [subjectId, setSubjectId] = useState(initialSubjectId);
  const [levelId, setLevelId] = useState(initialLevelId);
  const [departmentId, setDepartmentId] = useState(initialDepartmentId);
  const [examType, setExamType] = useState(initialExamType);
  const [delivery, setDelivery] = useState(initialDelivery);
  const [marks, setMarks] = useState(initialMarks);
  const [method, setMethod] = useState(initialMethod);
  const [waecMode, setWaecMode] = useState(initialWaecMode);
  const submitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A change to WHICH paper this is (subject/level/exam type/delivery/waec)
  // submits on its own tick, after state has settled, so the hidden inputs
  // below carry the new values rather than the ones from before the click.
  function submitSoon() {
    if (submitTimer.current) clearTimeout(submitTimer.current);
    submitTimer.current = setTimeout(() => formRef.current?.requestSubmit(), 0);
  }
  useEffect(() => () => { if (submitTimer.current) clearTimeout(submitTimer.current); }, []);
  // Keep local method state truthful if the server hands back a different
  // value than what's showing (fresh load, shared link, etc). Method itself
  // never triggers a round-trip, so this only reacts to the server's value.
  useEffect(() => { setMethod(initialMethod); }, [initialMethod]);
  // A series with a forced mode overrides whatever the teacher last had
  // selected — the choice isn't theirs to make in cbt/written mode.
  useEffect(() => {
    if (lockedDelivery && delivery !== lockedDelivery) { setDelivery(lockedDelivery); submitSoon(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lockedDelivery]);

  const subjectOptions = [...new Map(scopes.map((s) => [s.subjectId, s.subject])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]));
  const levelOptions = scopes
    .filter((s) => s.subjectId === subjectId)
    .map((s) => ({ key: `${s.levelId}:${s.departmentId ?? ''}`, levelId: s.levelId, departmentId: s.departmentId, label: s.department ? `${s.level} · ${s.department}` : s.level }));

  const subject = scopes.find((s) => s.subjectId === subjectId)?.subject ?? '';
  const level = scopes.find((s) => s.levelId === levelId)?.level ?? '';
  const isEnglish = subject.toLowerCase().includes('english');
  const isSenior = /\bss?s?\s*[123]\b/i.test(level) || level.toLowerCase().includes('senior');
  const waecEligible = isEnglish && isSenior && delivery !== 'written';

  return (
    <>
      <form ref={formRef} action={action}>
        <input type="hidden" name="subjectId" value={subjectId || ''} />
        <input type="hidden" name="levelId" value={levelId || ''} />
        <input type="hidden" name="departmentId" value={departmentId ?? ''} />
        <input type="hidden" name="examType" value={examType} />
        <input type="hidden" name="delivery" value={delivery} />
        <input type="hidden" name="marks" value={marks} />
        <input type="hidden" name="method" value={method} />
        <input type="hidden" name="waecMode" value={waecEligible && waecMode ? '1' : ''} />

        <div className="qs-row qs-row--context">
          <div className="qs-field">
            <span className="qs-label">Delivery Mode</span>
            {lockedDelivery ? (
              <p className="qs-hint" style={{ margin: '4px 0 0' }}>
                {lockedDelivery === 'written'
                  ? 'This examination is written/paper-based — every subject is Written.'
                  : 'This examination is CBT-based — every subject is CBT.'}
              </p>
            ) : (
              <div className="qs-toggle" role="group" aria-label="Delivery mode">
                <button type="button" className={delivery === 'cbt' ? 'is-active' : ''}
                  onClick={() => { setDelivery('cbt'); submitSoon(); }}>CBT</button>
                <button type="button" className={delivery === 'written' ? 'is-active' : ''}
                  onClick={() => { setDelivery('written'); submitSoon(); }}>Written</button>
              </div>
            )}
          </div>
        </div>

        <div className="qs-row">
          <div className="qs-field qs-field--grow">
            <label className="qs-label" htmlFor="qs-subject">Subject</label>
            <select id="qs-subject" value={subjectId || ''} onChange={(e) => {
              const sid = Number(e.target.value);
              const firstLevel = scopes.find((s) => s.subjectId === sid);
              setSubjectId(sid);
              setLevelId(firstLevel ? firstLevel.levelId : 0);
              setDepartmentId(firstLevel ? firstLevel.departmentId : null);
              submitSoon();
            }}>
              <option value="">Choose subject…</option>
              {subjectOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          </div>
          <div className="qs-field qs-field--grow">
            <label className="qs-label" htmlFor="qs-class">Class Level</label>
            <select id="qs-class" value={subjectId ? `${levelId}:${departmentId ?? ''}` : ''} disabled={!subjectId}
              onChange={(e) => {
                const [lvl, dept] = e.target.value.split(':');
                setLevelId(Number(lvl));
                setDepartmentId(dept ? Number(dept) : null);
                submitSoon();
              }}>
              <option value="">{subjectId ? 'Choose class level…' : 'Choose subject first…'}</option>
              {levelOptions.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
          </div>
          {delivery === 'cbt' ? (
            <div className="qs-field">
              <span className="qs-label">Exam Type</span>
              <div className="qs-toggle" role="group" aria-label="Exam type">
                <button type="button" className={examType === 'objective' ? 'is-active' : ''}
                  onClick={() => { setExamType('objective'); submitSoon(); }}>Objective</button>
                <button type="button" className={examType === 'theory' ? 'is-active' : ''} disabled={!theoryAllowed}
                  title={!theoryAllowed ? 'This collection accepts objective questions only.' : ''}
                  onClick={() => { if (theoryAllowed) { setExamType('theory'); submitSoon(); } }}>Theory</button>
              </div>
            </div>
          ) : null}
          {delivery === 'cbt' && examType === 'objective' ? (
            <div className="qs-field qs-field--narrow">
              <label className="qs-label" htmlFor="qs-marks">Default Marks</label>
              <input id="qs-marks" type="number" min="0.5" step="0.5" value={marks}
                onChange={(e) => setMarks(Number(e.target.value) || 1)}
                onBlur={() => submitSoon()} />
            </div>
          ) : null}
          {delivery === 'cbt' ? (
            <div className="qs-field">
              <label className="qs-label" htmlFor="qs-method">Method</label>
              <select id="qs-method" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
                <option value="manual">Manual Entry</option>
                <option value="paste">Paste in Format</option>
                <option value="csv">CSV / Excel Import</option>
              </select>
            </div>
          ) : null}
          {waecEligible ? (
            <div className="qs-field qs-field--waec">
              <label>
                <input type="checkbox" checked={waecMode} onChange={(e) => { setWaecMode(e.target.checked); submitSoon(); }} />
                WAEC Standard
              </label>
              <span className="qs-hint">60-obj English structure</span>
            </div>
          ) : null}
        </div>
      </form>

      {!subjectId || !levelId ? (
        <p className="muted" style={{ marginTop: 18 }}>Choose a subject and class level to begin.</p>
      ) : delivery === 'written' ? (
        writtenIntent ?? opening
      ) : (
        (method === 'manual' ? manualEntry : method === 'paste' ? pasteImport : csvImport) ?? opening
      )}
    </>
  );
}
