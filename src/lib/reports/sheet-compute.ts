import { DEFAULT_RANKING, isVisibleToFamily, type RankingPolicy } from '@/domain/academic';
import { reportPositions, reportAverage, reportGradingKey } from '@/lib/reports/summary';
import type { ReportSheetData } from '@/lib/reports/sheet';

/** Legacy density system: see densityClass in the sheet component. */
export function densityClass(subjectCount: number): string {
  if (subjectCount <= 9) return 'fit-roomy';
  if (subjectCount <= 11) return 'fit-snug';
  if (subjectCount <= 14) return 'fit-tight';
  return 'fit-overflow';
}

/** Derived figures for one sheet: cohort statistics, class position, marks rows. Pure, no database. */
export function computeReportSheet(data: ReportSheetData, studentId: number) {
  const { student, school, enrolment, term, results, registered, cohort, cohortRows, cohortRegistrations, classTeacher } = data;
  // ── Cohort statistics, computed once ──────────────────────────────────────
  const perSubject = new Map<number, { totals: number[]; examTotals: number[] }>();

  for (const row of cohortRows) {
    if (!row.complete) continue;
    const total = Number(row.total);
    const exam = Number(row.examTotal);
    const subject = perSubject.get(row.subjectId) ?? { totals: [], examTotals: [] };
    subject.totals.push(total);
    subject.examTotals.push(exam);
    perSubject.set(row.subjectId, subject);

  }

  const classStats = new Map(Array.from(perSubject.entries()).map(([subjectId, s]) => [subjectId, {
    average: s.totals.reduce((a, b) => a + b, 0) / s.totals.length,
    highest: Math.max(...s.totals),
  }]));

  // Position in Class: rank the cohort on per-student average — the same
  // competition policy the compilation used for subject positions, taken from
  // the stored ranking policy when one exists.
  const storedPolicy = results.find(r => r.rankingPolicy)?.rankingPolicy as RankingPolicy | undefined;
  const policy = storedPolicy?.tiePolicy ? storedPolicy : DEFAULT_RANKING;
  const positions = reportPositions(cohort, cohortRows, cohortRegistrations, policy);
  const classPosition = positions.get(studentId) ?? 0;

  // ── Marks rows: registration is the spine; compiled scores join onto it ──
  const bySubject = new Map(results.map(r => [r.subjectId, r]));
  const rows: Array<{
    subjectName: string;
    result: typeof results[number] | null;
    classAverage: number | null;
    highest: number | null;
  }> = [];
  for (const reg of registered) {
    const result = bySubject.get(reg.subjectId) ?? null;
    const stats = classStats.get(reg.subjectId);
    rows.push({
      subjectName: reg.subjectName,
      result,
      classAverage: stats?.average ?? null,
      highest: stats?.highest ?? null,
    });
    if (result) bySubject.delete(reg.subjectId);
  }
  // Compiled scores for subjects no longer registered are still real marks —
  // keep them on the sheet rather than hiding them.
  for (const [, result] of bySubject) {
    rows.push({
      subjectName: result.subjectName,
      result,
      classAverage: classStats.get(result.subjectId)?.average ?? null,
      highest: classStats.get(result.subjectId)?.highest ?? null,
    });
  }

  const ranked = results.filter((r) => r.complete);
  const totalMarks = ranked.reduce((s, r) => s + Number(r.total), 0);
  const average = reportAverage(ranked.map(r => Number(r.total)));

  // Staff may read a compiled result before it is published; a family may not.
  const anyUnpublished = results.some((r) => !isVisibleToFamily(r.state));

  const density = densityClass(rows.length);
  const hasCrest = Boolean(school?.logoUrl);
  const contact = [school?.phone, school?.email].filter(Boolean).join('  •  ');
  const classTeacherName = classTeacher
    ? `${classTeacher.firstName} ${classTeacher.lastName}` : '';

  const gradingKey = reportGradingKey(results, data.scaleSnapshots.map(s => s.snapshot));
  const editableRemarks = results.length > 0 && results.every(r => ['draft', 'compiled'].includes(r.state) && !r.published);
  // The saved signatures are plain data here; the sheet component decides how to draw them.
  const signatures: Partial<NonNullable<typeof data.extras>['signatures']> = data.extras?.signatures ?? {};
  return { student, school, enrolment, term, results, cohort, rows, ranked, totalMarks, average, classPosition,
    anyUnpublished, density, hasCrest, contact, classTeacherName, gradingKey, editableRemarks, signatures, extras: data.extras, classTeacher, templateKey: data.templates.report };
}
