'use client';

/** Auto-submits on change, same pattern as ../ca/PairPicker.tsx. */
export function ComponentPicker({ value, components }: {
  value: string;
  components: { key: string; label: string; maxScore: number; isExam: boolean }[];
}) {
  return (
    <select
      id="analysis-component"
      name="component"
      required
      defaultValue={value}
      onChange={(e) => e.currentTarget.form?.submit()}
    >
      {components.map((c) => (
        <option key={c.key} value={c.key}>
          {c.label}{c.isExam ? ' (exam)' : ` (max ${c.maxScore})`}
        </option>
      ))}
    </select>
  );
}
