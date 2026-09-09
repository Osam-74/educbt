import { rank, WAEC_NINE_POINT, type RankingPolicy } from '@/domain/academic';

type Row = { studentId: number; subjectId: number; total: string; examTotal: string; complete: boolean };
type Registration = { studentId: number; subjectId: number };

/** Read-only report ranking; completeness covers the whole registered subject set. */
export function reportPositions(cohort: { studentId: number; admissionNumber: string }[], rows: Row[], registrations: Registration[], policy: RankingPolicy) {
  const rankable = cohort.flatMap(student => {
    const own = rows.filter(r => r.studentId === student.studentId);
    const scored = own.filter(r => r.complete);
    if (!scored.length) return [];
    const expected = registrations.filter(r => r.studentId === student.studentId);
    const complete = own.every(r => r.complete) && expected.every(reg => own.some(r => r.subjectId === reg.subjectId && r.complete));
    const total = scored.reduce((sum, r) => sum + Number(r.total), 0);
    const exam = scored.reduce((sum, r) => sum + Number(r.examTotal), 0);
    return [{ ...student, total: Math.round(total / scored.length * 100),
      examTotal: Math.round(exam / scored.length * 100), caTotal: Math.round((total - exam) / scored.length * 100), complete }];
  });
  return new Map(rank(rankable, policy).map(r => [r.studentId, r.position]));
}

export function reportAverage(totals: number[]) {
  if (!totals.length) return '—';
  const average = Math.round(totals.reduce((sum, n) => sum + n, 0) / totals.length * 10) / 10;
  return `${average}%`;
}

/** Only a known immutable scale version can explain historical grades. */
export function reportGradingKey(rows: { scaleId: string; scaleVersion: number }[]) {
  if (!rows.length) return 'No compiled grading scale available.';
  if (!rows.every(r => r.scaleId === WAEC_NINE_POINT.id && r.scaleVersion === WAEC_NINE_POINT.version)) {
    const versions = [...new Set(rows.map(r => `${r.scaleId || 'unspecified'} v${r.scaleVersion}`))].join(', ');
    return `Historical grading key unavailable (${versions}). Grades are shown as compiled.`;
  }
  const bands = [...WAEC_NINE_POINT.bands].sort((a, b) => b.min - a.min);
  return bands.map((band, i) => `${band.grade}: ${band.min}–${i === 0 ? 100 : bands[i - 1]!.min - 1} (${band.remark})`).join('  |  ');
}
