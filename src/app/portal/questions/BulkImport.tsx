'use client';
/**
 * Paste-in-format and CSV/Excel import (legacy parity: renderPasteEntry,
 * renderCSVImport and the shared staging table in
 * templates/portal/exams/questions.php). Parsing happens in the browser so a
 * teacher sees exactly what will be added — and what will not — before
 * anything is written; only the rows still ticked "valid" go to the server.
 */
import { useState } from 'react';
import { CSV_TEMPLATE, PASTE_GUIDE, parseCSV, parseObjectivePaste, parseTheoryPaste, type ParsedRow } from './parsers';
import { bulkAddQuestions } from './actions';

export default function BulkImport({
  mode,
  examType,
  defaultMarks,
  setId,
}: {
  mode: 'paste' | 'csv';
  examType: 'objective' | 'theory';
  defaultMarks: number;
  setId: number;
}) {
  const isTheory = examType === 'theory';
  const [text, setText] = useState('');
  const [rows, setRows] = useState<ParsedRow[] | null>(null);
  const [included, setIncluded] = useState<boolean[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ added: number; failed: Array<{ index: number; text: string; reason: string }> } | null>(null);

  function stage(parsed: ParsedRow[]) {
    setRows(parsed);
    setIncluded(parsed.map((r) => r.status === 'valid'));
    setResult(null);
  }

  function parseNow() {
    if (mode === 'paste') {
      if (!text.trim()) return;
      stage(isTheory ? parseTheoryPaste(text, defaultMarks) : parseObjectivePaste(text, defaultMarks));
    }
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => stage(parseCSV(String(reader.result ?? ''), isTheory, defaultMarks));
    reader.readAsText(file);
  }

  function downloadTemplate() {
    const blob = new Blob([CSV_TEMPLATE[examType]], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `template_${examType}.csv`;
    a.click();
  }

  async function submit() {
    if (!rows) return;
    const items = rows.filter((_, i) => included[i]);
    if (!items.length) return;
    setBusy(true);
    try {
      const outcome = await bulkAddQuestions(setId, examType, items);
      setResult(outcome);
      setRows(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="qs-import">
      {mode === 'paste' ? (
        <>
          <h3>Paste Questions — {isTheory ? 'Theory' : 'Objective'}</h3>
          <details className="qs-guide">
            <summary>Format Guide</summary>
            <pre>{PASTE_GUIDE[examType]}</pre>
          </details>
          <textarea rows={12} value={text} onChange={(e) => setText(e.target.value)}
            placeholder="Paste your questions here…" className="qs-mono" />
          <div className="qs-actions">
            <button type="button" className="sd-action" onClick={parseNow}>Parse &amp; Preview</button>
          </div>
        </>
      ) : (
        <>
          <h3>CSV / Excel Import — {isTheory ? 'Theory' : 'Objective'}</h3>
          <div className="qs-actions">
            <button type="button" className="sd-action sd-action--ghost" onClick={downloadTemplate}>Download Template</button>
          </div>
          <input type="file" accept=".csv" onChange={onFile} />
          <p className="qs-hint">
            Columns: <code>{isTheory ? 'question, marks, marking_guide' : 'question, option_a, option_b, option_c, option_d, correct_option, marks'}</code>
          </p>
        </>
      )}

      {rows && rows.length > 0 ? (
        <div className="qs-staging">
          <table className="tbl">
            <thead><tr><th /><th>Question</th><th>Marks</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className={r.status === 'error' ? 'qs-row--error' : ''}>
                  <td><input type="checkbox" checked={included[i]} disabled={r.status === 'error'}
                    onChange={(e) => setIncluded((prev) => prev.map((v, idx) => idx === i ? e.target.checked : v))} /></td>
                  <td>{r.text || <span className="muted">(no text)</span>}</td>
                  <td>{r.marks}</td>
                  <td>{r.status === 'valid' ? <span className="pill pill--approved">Valid</span> : <span className="pill pill--returned">{r.errors.join(' ')}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="qs-actions">
            <button type="button" className="sd-action" disabled={busy || !included.some(Boolean)} onClick={submit}>
              {busy ? 'Adding…' : `Add ${included.filter(Boolean).length} question${included.filter(Boolean).length === 1 ? '' : 's'}`}
            </button>
            <button type="button" className="sd-action sd-action--ghost" onClick={() => setRows(null)}>Cancel</button>
          </div>
        </div>
      ) : rows && rows.length === 0 ? <p className="muted">Nothing recognisable in that file.</p> : null}

      {result ? (
        <p className={result.failed.length ? 'note' : 'ok'}>
          Added {result.added} question{result.added === 1 ? '' : 's'}.
          {result.failed.length ? ` ${result.failed.length} could not be saved: ${result.failed.map((f) => f.reason).join(' ')}` : ''}
        </p>
      ) : null}
    </div>
  );
}
