'use client';

/**
 * The class/subject select needs an onChange handler to auto-submit, which
 * only a Client Component may hold — the page around it stays a Server
 * Component. Progressive enhancement (no JS) still works via the <noscript>
 * "Load" button in the parent form.
 */
export function PairPicker({ pair, pairs }: {
  pair: string;
  pairs: { classId: number; subjectId: number; className: string; subjectName: string }[];
}) {
  return (
    <select
      id="ca-pair"
      name="pair"
      required
      defaultValue={pair}
      onChange={e => e.currentTarget.form?.submit()}
    >
      <option value="">Choose</option>
      {pairs.map(p => (
        <option key={p.classId + ':' + p.subjectId} value={p.classId + ':' + p.subjectId}>
          {p.className} — {p.subjectName}
        </option>
      ))}
    </select>
  );
}
