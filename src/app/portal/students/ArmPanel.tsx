'use client';

import { useMemo, useState } from 'react';
import { assignArms } from './arm-actions';

type Source = { id: number; name: string; students: number };
type Target = { id: number; name: string };
type Person = { id: number; admissionNumber: string; firstName: string; lastName: string };

/**
 * "Assign arms": tick the students of one class and move them into an arm of the same level. A split is not a
 * promotion: results, subjects and history stay with each student. The rules are enforced on the server; this panel
 * only helps choose.
 */
export default function ArmPanel({ sources, targetsByClass, rosterByClass, selectedClass, returnParams }: {
  sources: Source[]; targetsByClass: Record<number, Target[]>; rosterByClass: Record<number, Person[]>; selectedClass: number; returnParams: string;
}) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState<number>(selectedClass || sources[0]?.id || 0);
  const [ticked, setTicked] = useState<Set<number>>(new Set());
  const roster = useMemo(() => rosterByClass[from] ?? [], [rosterByClass, from]);
  const targets = targetsByClass[from] ?? [];
  const [to, setTo] = useState<number>(0);
  const chosen = targets.some((t) => t.id === to) ? to : 0;

  if (sources.length === 0) return null;
  const change = (id: number) => { setFrom(id); setTicked(new Set()); setTo(0); };
  const toggle = (id: number) => setTicked((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <section className="card sa-card" data-testid="arm-panel-wrap">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h2 style={{ margin: 0 }}>Assign arms</h2>
          <p className="muted" style={{ margin: '4px 0 0', fontSize: 13 }}>Split a class into its arms. Their results, subjects and history stay with them.</p>
        </div>
        <button type="button" className="sa-btn" aria-expanded={open} aria-controls="arm-panel" onClick={() => setOpen(!open)} data-testid="arm-open">
          {open ? 'Close' : 'Assign arms'}
        </button>
      </div>

      {open ? (
        <form id="arm-panel" action={assignArms} data-testid="arm-panel" style={{ marginTop: 14 }}>
          <input type="hidden" name="returnParams" value={returnParams} />
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div>
              <label htmlFor="arm-from">From class</label>
              <select id="arm-from" value={from} onChange={(e) => change(Number(e.target.value))}>
                {sources.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.students})</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="arm-to">Move to arm</label>
              <select id="arm-to" name="toClassId" value={chosen} onChange={(e) => setTo(Number(e.target.value))} required>
                <option value="">Choose an arm…</option>
                {targets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <button type="button" className="sa-btn" onClick={() => setTicked(new Set(roster.map((p) => p.id)))} data-testid="arm-all">Tick all</button>
            <button type="button" className="sa-btn" onClick={() => setTicked(new Set())} data-testid="arm-none">Clear ticks</button>
            <span aria-live="polite" data-testid="arm-count">{ticked.size} selected</span>
            <button type="submit" className="sa-btn sa-btn--primary" disabled={ticked.size === 0 || chosen === 0} data-testid="arm-apply">Apply</button>
          </div>
          {targets.length === 0 ? <p className="muted">This class has no other active arm of the same level to move students into.</p> : null}

          <div className="sa-table-wrap" style={{ marginTop: 12 }}>
            <table className="sa-table">
              <thead><tr><th style={{ width: 34 }}><span className="sr-only">Select</span></th><th>Admission no.</th><th>Student</th></tr></thead>
              <tbody>
                {roster.map((p) => (
                  <tr key={p.id} data-student={p.id}>
                    <td><input type="checkbox" name="studentIds" value={p.id} checked={ticked.has(p.id)} onChange={() => toggle(p.id)} aria-label={`Select ${p.firstName} ${p.lastName}`} /></td>
                    <td>{p.admissionNumber}</td>
                    <td>{p.lastName}, {p.firstName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </form>
      ) : null}
    </section>
  );
}
