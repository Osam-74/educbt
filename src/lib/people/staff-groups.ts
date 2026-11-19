/**
 * Client-safe copy of the row-grouping rule (staff.ts imports the database, which a browser component must not).
 * staff.ts re-exports this same function, so the unit test and the form run the identical code.
 */
export function groupDutyRows(subjectClasses: Record<number, number[]>): Array<{ subjectIds: number[]; classIds: number[] }> {
  const byClasses = new Map<string, { subjectIds: number[]; classIds: number[] }>();
  for (const [subject, classes] of Object.entries(subjectClasses)) {
    const classIds = [...new Set(classes)].sort((a, b) => a - b);
    if (classIds.length === 0) continue;
    const key = classIds.join(',');
    const row = byClasses.get(key) ?? { subjectIds: [], classIds };
    row.subjectIds.push(Number(subject));
    byClasses.set(key, row);
  }
  return [...byClasses.values()];
}
