/**
 * Exam timetable + invigilation scheduling (legacy EduCBT Pro parity).
 *
 * Legacy reference: templates/portal/exams/timetable.php, invigilation.php,
 * includes/Services/{TimetableService,InvigilationScheduleService}.php.
 *
 * THE MODEL: a timetable is not a stored document — it is a VIEW over papers.
 * A paper's slot (date/time/duration/venue), its invigilator and its access
 * code are all carried on the paper row itself. The release gate is the
 * series: until an examination is published, its timetable is a working
 * draft that only the exam office can see.
 *
 * Two rules make an invigilation schedule worth anything, and both are
 * enforced on every automatic and manual assignment:
 *   - THE SUBJECT TEACHER DOES NOT INVIGILATE THEIR OWN PAPER. It puts a
 *     teacher in an impossible position and it is the first thing an
 *     external moderator checks.
 *   - NOBODY IS IN TWO HALLS AT ONCE. Overlap is checked against the whole
 *     paper window (scheduled_at → closes_at), not merely the start time.
 */

import { and, asc, eq, ne, isNotNull, gt, lt, inArray } from 'drizzle-orm';
import { forSchool, schema, Tx } from '@/db';
import type { Actor } from '@/lib/session';
import { SCHOOL_WIDE } from '@/lib/session';

export type TimetablePaper = {
  id: number;
  subjectName: string;
  className: string | null;
  levelName: string | null;
  scheduledAt: Date | null;
  closesAt: Date | null;
  durationMinutes: number;
  venue: string | null;
  status: string;
  requiresAccessCode: boolean;
  accessCode: string | null;
  codeReleasedAt: Date | null;
  invigilatorStaffId: number | null;
  invigilatorName: string | null;
};

export type TimetableResult = {
  series: {
    id: number;
    title: string;
    seriesType: string;
    status: string;
    released: boolean;
  };
  papers: TimetablePaper[];
  manage: boolean;
};

const MANAGE_ROLES = SCHOOL_WIDE;

export function canManageTimetable(actor: Actor): boolean {
  return MANAGE_ROLES.includes(actor.role as (typeof MANAGE_ROLES)[number]);
}

async function loadPapers(tx: Tx, schoolId: number, seriesId: number): Promise<TimetablePaper[]> {
  const staff = schema.staff;
  const rows = await tx
    .select({
      id: schema.examPapers.id,
      subjectName: schema.subjects.name,
      className: schema.classes.displayName,
      levelName: schema.classLevels.name,
      scheduledAt: schema.examPapers.scheduledAt,
      closesAt: schema.examPapers.closesAt,
      durationSeconds: schema.examPapers.durationSeconds,
      venue: schema.examPapers.venue,
      status: schema.examPapers.status,
      requiresAccessCode: schema.examPapers.requiresAccessCode,
      accessCode: schema.examPapers.accessCode,
      codeReleasedAt: schema.examPapers.codeReleasedAt,
      invigilatorStaffId: schema.examPapers.invigilatorStaffId,
      invigFirst: staff.firstName,
      invigLast: staff.lastName,
    })
    .from(schema.examPapers)
    .innerJoin(schema.subjects, eq(schema.subjects.id, schema.examPapers.subjectId))
    .leftJoin(schema.classes, eq(schema.classes.id, schema.examPapers.classId))
    .leftJoin(schema.classLevels, eq(schema.classLevels.id, schema.examPapers.levelId))
    .leftJoin(staff, eq(staff.id, schema.examPapers.invigilatorStaffId))
    .where(and(
      eq(schema.examPapers.schoolId, schoolId),
      eq(schema.examPapers.seriesId, seriesId),
      ne(schema.examPapers.status, 'cancelled'),
    ))
    .orderBy(asc(schema.examPapers.scheduledAt), asc(schema.subjects.name));

  return rows.map((r) => ({
    id: r.id,
    subjectName: r.subjectName,
    className: r.className,
    levelName: r.levelName,
    scheduledAt: r.scheduledAt,
    closesAt: r.closesAt,
    durationMinutes: Math.round(r.durationSeconds / 60),
    venue: r.venue,
    status: r.status,
    requiresAccessCode: r.requiresAccessCode,
    accessCode: r.accessCode,
    codeReleasedAt: r.codeReleasedAt,
    invigilatorStaffId: r.invigilatorStaffId,
    invigilatorName: r.invigFirst ? `${r.invigFirst} ${r.invigLast ?? ''}`.trim() : null,
  }));
}

/**
 * The timetable for one examination, role-gated the way the legacy portal
 * gated it: the exam office sees the working draft; everyone else sees a
 * timetable only once the examination is published (the release). Practice
 * series are always visible — practice is never a secret.
 */
export async function timetableForSeries(actor: Actor, seriesId: number): Promise<TimetableResult | null> {
  if (!Number.isInteger(seriesId) || seriesId <= 0) return null;

  const manage = canManageTimetable(actor);

  return forSchool(actor.schoolId, async (tx) => {
    const [series] = await tx.select({
      id: schema.examSeries.id,
      title: schema.examSeries.title,
      seriesType: schema.examSeries.seriesType,
      status: schema.examSeries.status,
    })
      .from(schema.examSeries)
      .where(and(
        eq(schema.examSeries.id, seriesId),
        eq(schema.examSeries.schoolId, actor.schoolId),
      ))
      .limit(1);

    if (!series) return null;

    const released = series.status === 'published' || series.seriesType === 'practice';
    if (!released && !manage) return { series: { ...series, released }, papers: [], manage: false };

    const papers = await loadPapers(tx, actor.schoolId, seriesId);
    return { series: { ...series, released }, papers, manage };
  });
}

// ── Rescheduling ─────────────────────────────────────────────────────────────

export type RescheduleInput = {
  scheduledAt?: string;      // ISO datetime
  durationMinutes?: number; // 1..600
  venue?: string;
};

export type RescheduleResult =
  | { ok: true }
  | { ok: false; error: 'not_found' | 'not_scheduled' | 'clash' | 'bad_input'; clashWith?: string };

/**
 * Move one paper on the timetable (the per-row form in the legacy exam
 * office timetable). `closesAt` is recomputed so the invigilation clash
 * check can never read a stale window.
 *
 * CONFLICT SAFEGUARD: a class cannot sit two papers at once — the same
 * window-overlap check invigilators are held to, applied to the class.
 * The office can override with force, because schools sometimes do run
 * two papers in one hall under one team of invigilators.
 */
export async function reschedulePaper(
  actor: Actor,
  paperId: number,
  input: RescheduleInput,
  force = false,
): Promise<RescheduleResult> {
  if (!canManageTimetable(actor)) return { ok: false, error: 'not_found' };
  if (!Number.isInteger(paperId) || paperId <= 0) return { ok: false, error: 'bad_input' };

  const duration = input.durationMinutes === undefined
    ? undefined
    : Math.trunc(input.durationMinutes);
  if (duration !== undefined && (duration < 1 || duration > 600)) {
    return { ok: false, error: 'bad_input' };
  }

  return forSchool(actor.schoolId, async (tx) => {
    const [paper] = await tx.select({
      id: schema.examPapers.id,
      classId: schema.examPapers.classId,
      levelId: schema.examPapers.levelId,
      subjectName: schema.subjects.name,
      scheduledAt: schema.examPapers.scheduledAt,
      durationSeconds: schema.examPapers.durationSeconds,
      status: schema.examPapers.status,
    })
      .from(schema.examPapers)
      .innerJoin(schema.subjects, eq(schema.subjects.id, schema.examPapers.subjectId))
      .where(and(
        eq(schema.examPapers.id, paperId),
        eq(schema.examPapers.schoolId, actor.schoolId),
      ))
      .limit(1);

    if (!paper) return { ok: false, error: 'not_found' } as const;

    let scheduledAt: Date | null = paper.scheduledAt;
    if (input.scheduledAt !== undefined) {
      if (input.scheduledAt === '') {
        scheduledAt = null;
      } else {
        const d = new Date(input.scheduledAt);
        if (Number.isNaN(d.getTime())) return { ok: false, error: 'bad_input' } as const;
        scheduledAt = d;
      }
    }
    if (!scheduledAt) return { ok: false, error: 'not_scheduled' } as const;

    const durationSeconds = duration === undefined ? paper.durationSeconds : duration * 60;
    const closesAt = new Date(scheduledAt.getTime() + durationSeconds * 1000);

    if (!force) {
      // Same class, overlapping window, not this paper. A class cannot sit
      // two papers at once.
      const clashConditions = [
        ne(schema.examPapers.id, paperId),
        eq(schema.examPapers.schoolId, actor.schoolId),
        ne(schema.examPapers.status, 'cancelled'),
        isNotNull(schema.examPapers.scheduledAt),
        lt(schema.examPapers.scheduledAt, closesAt),
        gt(schema.examPapers.closesAt, scheduledAt),
      ];
      if (paper.classId !== null) clashConditions.push(eq(schema.examPapers.classId, paper.classId));
      else if (paper.levelId !== null) clashConditions.push(eq(schema.examPapers.levelId, paper.levelId));

      const [clash] = await tx.select({ subjectName: schema.subjects.name })
        .from(schema.examPapers)
        .innerJoin(schema.subjects, eq(schema.subjects.id, schema.examPapers.subjectId))
        .where(and(...clashConditions))
        .limit(1);

      if (clash) return { ok: false, error: 'clash', clashWith: clash.subjectName } as const;
    }

    await tx.update(schema.examPapers)
      .set({
        scheduledAt,
        closesAt,
        durationSeconds,
        venue: input.venue === undefined ? undefined : (input.venue === '' ? null : input.venue),
      })
      .where(and(
        eq(schema.examPapers.id, paperId),
        eq(schema.examPapers.schoolId, actor.schoolId),
      ));

    await tx.insert(schema.auditLog).values({
      schoolId: actor.schoolId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'exam.paper_rescheduled',
      entityType: 'exam_papers',
      entityId: paperId,
      after: { scheduledAt: scheduledAt.toISOString(), durationMinutes: Math.round(durationSeconds / 60), venue: input.venue ?? null, forced: force || null },
    });

    return { ok: true } as const;
  });
}

// ── Invigilator assignment ───────────────────────────────────────────────────

export type ReassignResult =
  | { ok: true }
  | { ok: false; error: 'not_found' | 'teaches_this_subject' | 'already_invigilating_then' };

/** Is this staff member the active subject teacher for the paper's subject+class? */
async function teachesSubject(tx: Tx, schoolId: number, staffId: number, subjectId: number, classId: number | null): Promise<boolean> {
  const conditions = [
    eq(schema.staffAssignments.schoolId, schoolId),
    eq(schema.staffAssignments.staffId, staffId),
    eq(schema.staffAssignments.subjectId, subjectId),
    eq(schema.staffAssignments.assignmentType, 'subject_teacher'),
    eq(schema.staffAssignments.status, 'active'),
  ];
  if (classId !== null) conditions.push(eq(schema.staffAssignments.classId, classId));
  const [row] = await tx.select({ id: schema.staffAssignments.id })
    .from(schema.staffAssignments)
    .where(and(...conditions))
    .limit(1);
  return !!row;
}

/**
 * Assign (or clear, staffId = 0) one paper's invigilator. Both hard rules from
 * the legacy reassign() apply; a clash can be overridden with force because in
 * a CBT hall one invigilator can legally watch two papers from one room.
 */
export async function setPaperInvigilator(
  actor: Actor,
  paperId: number,
  staffId: number,
  force = false,
): Promise<ReassignResult> {
  if (!canManageTimetable(actor)) return { ok: false, error: 'not_found' };
  if (!Number.isInteger(paperId) || paperId <= 0 || !Number.isInteger(staffId) || staffId < 0) {
    return { ok: false, error: 'not_found' };
  }

  return forSchool(actor.schoolId, async (tx) => {
    const [paper] = await tx.select({
      id: schema.examPapers.id,
      subjectId: schema.examPapers.subjectId,
      classId: schema.examPapers.classId,
      scheduledAt: schema.examPapers.scheduledAt,
      closesAt: schema.examPapers.closesAt,
    })
      .from(schema.examPapers)
      .where(and(
        eq(schema.examPapers.id, paperId),
        eq(schema.examPapers.schoolId, actor.schoolId),
      ))
      .limit(1);

    if (!paper) return { ok: false, error: 'not_found' } as const;

    if (staffId === 0) {
      await tx.update(schema.examPapers)
        .set({ invigilatorStaffId: null })
        .where(and(
          eq(schema.examPapers.id, paperId),
          eq(schema.examPapers.schoolId, actor.schoolId),
        ));
      return { ok: true } as const;
    }

    const [staffRow] = await tx.select({ id: schema.staff.id })
      .from(schema.staff)
      .where(and(
        eq(schema.staff.id, staffId),
        eq(schema.staff.schoolId, actor.schoolId),
        eq(schema.staff.status, 'active'),
      ))
      .limit(1);
    if (!staffRow) return { ok: false, error: 'not_found' } as const;

    if (await teachesSubject(tx, actor.schoolId, staffId, paper.subjectId, paper.classId)) {
      return { ok: false, error: 'teaches_this_subject' } as const;
    }

    if (!force && paper.scheduledAt && paper.closesAt) {
      const [clash] = await tx.select({ id: schema.examPapers.id })
        .from(schema.examPapers)
        .where(and(
          eq(schema.examPapers.schoolId, actor.schoolId),
          eq(schema.examPapers.invigilatorStaffId, staffId),
          ne(schema.examPapers.id, paperId),
          ne(schema.examPapers.status, 'cancelled'),
          isNotNull(schema.examPapers.scheduledAt),
          lt(schema.examPapers.scheduledAt, paper.closesAt),
          gt(schema.examPapers.closesAt, paper.scheduledAt),
        ))
        .limit(1);
      if (clash) return { ok: false, error: 'already_invigilating_then' } as const;
    }

    await tx.update(schema.examPapers)
      .set({ invigilatorStaffId: staffId })
      .where(and(
        eq(schema.examPapers.id, paperId),
        eq(schema.examPapers.schoolId, actor.schoolId),
      ));

    await tx.insert(schema.auditLog).values({
      schoolId: actor.schoolId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'exam.invigilator_assigned',
      entityType: 'exam_papers',
      entityId: paperId,
      after: { staffId, forced: force || null },
    });

    return { ok: true } as const;
  });
}

/**
 * Propose an invigilator for every unscheduled paper in a series, spreading
 * the load and honouring both hard rules (legacy propose()).
 */
export async function proposeInvigilation(
  actor: Actor,
  seriesId: number,
): Promise<{ assigned: number; unfilled: string[] } | null> {
  if (!canManageTimetable(actor)) return null;

  return forSchool(actor.schoolId, async (tx) => {
    const papers = await loadPapers(tx, actor.schoolId, seriesId);
    const scheduled = papers.filter((p) => p.scheduledAt && p.closesAt && p.status !== 'draft');

    // The office organises the exam; teachers invigilate it. A principal or
    // exam officer is never proposed for a hall — they are the people the
    // schedule escalates to when something goes wrong.
    const staff = await tx.select({
      id: schema.staff.id,
      firstName: schema.staff.firstName,
      lastName: schema.staff.lastName,
    })
      .from(schema.staff)
      .where(and(
        eq(schema.staff.schoolId, actor.schoolId),
        eq(schema.staff.status, 'active'),
        eq(schema.staff.role, 'teacher'),
      ));

    if (!staff.length) return { assigned: 0, unfilled: ['no active staff to assign'] };

    // Running load, so the proposal spreads work rather than piling it on
    // whoever sorts first. Existing manual assignments count.
    const load = new Map<number, number>();
    const booked = new Map<number, TimetablePaper[]>();
    for (const p of scheduled) {
      if (p.invigilatorStaffId) {
        load.set(p.invigilatorStaffId, (load.get(p.invigilatorStaffId) ?? 0) + 1);
        booked.set(p.invigilatorStaffId, [...(booked.get(p.invigilatorStaffId) ?? []), p]);
      }
    }

    // subjectId per paper, needed for the teaches-this-subject rule.
    const paperSubjects = await tx.select({
      id: schema.examPapers.id,
      subjectId: schema.examPapers.subjectId,
      classId: schema.examPapers.classId,
    })
      .from(schema.examPapers)
      .where(and(
        eq(schema.examPapers.schoolId, actor.schoolId),
        eq(schema.examPapers.seriesId, seriesId),
        ne(schema.examPapers.status, 'cancelled'),
      ));
    const subjectOf = new Map(paperSubjects.map((p) => [p.id, p]));

    let assigned = 0;
    const unfilled: string[] = [];

    for (const paper of scheduled) {
      if (paper.invigilatorStaffId) continue;

      const meta = subjectOf.get(paper.id)!;
      const start = paper.scheduledAt!.getTime();
      const end = paper.closesAt!.getTime();

      const candidates = [...staff].sort((a, b) =>
        (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0));

      let chosen: number | null = null;

      for (const member of candidates) {
        // Never the teacher of that subject in that class.
        if (await teachesSubject(tx, actor.schoolId, member.id, meta.subjectId, meta.classId)) continue;

        // Never in two halls at once — the whole window, not the start time.
        const clash = (booked.get(member.id) ?? []).some((other) => {
          if (!other.scheduledAt || !other.closesAt) return false;
          return start < other.closesAt.getTime() && other.scheduledAt.getTime() < end;
        });
        if (clash) continue;

        chosen = member.id;
        break;
      }

      if (chosen === null) {
        unfilled.push(`${paper.subjectName} — ${paper.className ?? paper.levelName ?? 'unassigned class'}`);
        continue;
      }

      await tx.update(schema.examPapers)
        .set({ invigilatorStaffId: chosen })
        .where(and(
          eq(schema.examPapers.id, paper.id),
          eq(schema.examPapers.schoolId, actor.schoolId),
        ));

      load.set(chosen, (load.get(chosen) ?? 0) + 1);
      booked.set(chosen, [...(booked.get(chosen) ?? []), paper]);
      assigned++;
    }

    await tx.insert(schema.auditLog).values({
      schoolId: actor.schoolId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'exam.invigilation_proposed',
      entityType: 'exam_series',
      entityId: seriesId,
      after: { assigned, unfilled: unfilled.length },
    });

    return { assigned, unfilled };
  });
}

/**
 * Where the schedule no longer matches the timetable (legacy drift()):
 * unfilled papers, invigilators watching a subject they teach, and anyone
 * in two halls at once after a reschedule.
 */
export async function invigilationDrift(actor: Actor, seriesId: number): Promise<string[]> {
  if (!canManageTimetable(actor)) return [];

  return forSchool(actor.schoolId, async (tx) => {
    const papers = (await loadPapers(tx, actor.schoolId, seriesId))
      .filter((p) => p.scheduledAt && p.status !== 'draft');
    const issues = new Set<string>();

    const paperSubjects = await tx.select({
      id: schema.examPapers.id,
      subjectId: schema.examPapers.subjectId,
      classId: schema.examPapers.classId,
    })
      .from(schema.examPapers)
      .where(and(
        eq(schema.examPapers.schoolId, actor.schoolId),
        eq(schema.examPapers.seriesId, seriesId),
      ));
    const subjectOf = new Map(paperSubjects.map((p) => [p.id, p]));

    for (const paper of papers) {
      const label = `${paper.subjectName} — ${paper.className ?? paper.levelName ?? 'unassigned class'}`;
      const meta = subjectOf.get(paper.id)!;

      if (!paper.invigilatorStaffId) {
        issues.add(`${label} has no invigilator`);
        continue;
      }

      if (await teachesSubject(tx, actor.schoolId, paper.invigilatorStaffId, meta.subjectId, meta.classId)) {
        issues.add(`${paper.invigilatorName} invigilates ${paper.subjectName}, which they teach`);
      }

      for (const other of papers) {
        if (other.id === paper.id || other.invigilatorStaffId !== paper.invigilatorStaffId) continue;
        if (!other.scheduledAt || !other.closesAt || !paper.scheduledAt || !paper.closesAt) continue;
        if (paper.id > other.id) continue; // report each pair once

        if (paper.scheduledAt < other.closesAt && other.scheduledAt < paper.closesAt) {
          issues.add(`${paper.invigilatorName} is in two halls at once (${paper.subjectName} and ${other.subjectName})`);
        }
      }
    }

    return [...issues];
  });
}

/**
 * The papers of a series with their invigilators — the office's assignment
 * table, and (filtered to their own duties) a teacher's invigilation card.
 */
export async function invigilationPapers(
  actor: Actor,
  seriesId: number,
): Promise<{ papers: TimetablePaper[]; staff: { id: number; name: string }[]; mine: boolean } | null> {
  const manage = canManageTimetable(actor);
  const mine = !manage && actor.staffId !== null;

  return forSchool(actor.schoolId, async (tx) => {
    const [series] = await tx.select({ id: schema.examSeries.id })
      .from(schema.examSeries)
      .where(and(
        eq(schema.examSeries.id, seriesId),
        eq(schema.examSeries.schoolId, actor.schoolId),
      ))
      .limit(1);
    if (!series) return null;

    let papers = await loadPapers(tx, actor.schoolId, seriesId);
    if (mine) papers = papers.filter((p) => p.invigilatorStaffId === actor.staffId);

    const staff = manage ? await tx.select({
      id: schema.staff.id,
      firstName: schema.staff.firstName,
      lastName: schema.staff.lastName,
    })
      .from(schema.staff)
      .where(and(
        eq(schema.staff.schoolId, actor.schoolId),
        eq(schema.staff.status, 'active'),
      ))
      .orderBy(asc(schema.staff.firstName)) : [];

    return {
      papers,
      staff: staff.map((s) => ({ id: s.id, name: `${s.firstName} ${s.lastName ?? ''}`.trim() })),
      mine,
    };
  });
}

// ── Access codes ─────────────────────────────────────────────────────────────

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1 — read aloud, not confused

function generateCode(): string {
  let code = '';
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return code;
}

/**
 * Generate (or regenerate) a paper's access code. The old code stops working
 * immediately; the release stamp is cleared so the office must re-release it
 * deliberately (regenerating is not the same as announcing).
 */
export async function regenerateAccessCode(
  actor: Actor,
  paperId: number,
): Promise<{ ok: boolean; code?: string; error?: string }> {
  if (!canManageTimetable(actor)) return { ok: false, error: 'not_found' };

  return forSchool(actor.schoolId, async (tx) => {
    const [paper] = await tx.select({ id: schema.examPapers.id })
      .from(schema.examPapers)
      .where(and(
        eq(schema.examPapers.id, paperId),
        eq(schema.examPapers.schoolId, actor.schoolId),
      ))
      .limit(1);
    if (!paper) return { ok: false, error: 'not_found' } as const;

    const code = generateCode();
    await tx.update(schema.examPapers)
      .set({
        requiresAccessCode: true,
        accessCode: code,
        codeReleasedAt: null,
        codeReleasedBy: null,
      })
      .where(and(
        eq(schema.examPapers.id, paperId),
        eq(schema.examPapers.schoolId, actor.schoolId),
      ));

    await tx.insert(schema.auditLog).values({
      schoolId: actor.schoolId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'exam.access_code_regenerated',
      entityType: 'exam_papers',
      entityId: paperId,
    });

    return { ok: true, code } as const;
  });
}

/** Record that the invigilator read the code out (legacy release_code). */
export async function releaseAccessCode(
  actor: Actor,
  paperId: number,
): Promise<{ ok: boolean; error?: string }> {
  if (!canManageTimetable(actor)) return { ok: false, error: 'not_found' };

  return forSchool(actor.schoolId, async (tx) => {
    const [paper] = await tx.select({
      id: schema.examPapers.id,
      accessCode: schema.examPapers.accessCode,
    })
      .from(schema.examPapers)
      .where(and(
        eq(schema.examPapers.id, paperId),
        eq(schema.examPapers.schoolId, actor.schoolId),
      ))
      .limit(1);

    if (!paper || !paper.accessCode) return { ok: false, error: 'not_found' } as const;

    await tx.update(schema.examPapers)
      .set({ codeReleasedAt: new Date(), codeReleasedBy: actor.staffId })
      .where(and(
        eq(schema.examPapers.id, paperId),
        eq(schema.examPapers.schoolId, actor.schoolId),
      ));

    await tx.insert(schema.auditLog).values({
      schoolId: actor.schoolId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'exam.access_code_released',
      entityType: 'exam_papers',
      entityId: paperId,
    });

    return { ok: true } as const;
  });
}

/**
 * Upcoming papers for one student (legacy TimetableService::upcoming_for_student):
 * published, registered for the subject, in the future.
 */
export async function upcomingForStudent(
  tx: Tx,
  schoolId: number,
  studentId: number,
  limit = 20,
): Promise<{ subjectName: string; scheduledAt: Date; durationMinutes: number; venue: string | null }[]> {
  const rows = await tx.select({
    subjectName: schema.subjects.name,
    scheduledAt: schema.examPapers.scheduledAt,
    durationSeconds: schema.examPapers.durationSeconds,
    venue: schema.examPapers.venue,
  })
    .from(schema.examPapers)
    .innerJoin(schema.subjects, eq(schema.subjects.id, schema.examPapers.subjectId))
    .where(and(
      eq(schema.examPapers.schoolId, schoolId),
      eq(schema.examPapers.status, 'published'),
      isNotNull(schema.examPapers.scheduledAt),
      gt(schema.examPapers.scheduledAt, new Date()),
      inArray(
        schema.examPapers.subjectId,
        tx.select({ id: schema.studentSubjects.subjectId })
          .from(schema.studentSubjects)
          .where(eq(schema.studentSubjects.studentId, studentId)),
      ),
    ))
    .orderBy(asc(schema.examPapers.scheduledAt))
    .limit(limit);

  return rows.map((r) => ({
    subjectName: r.subjectName,
    scheduledAt: r.scheduledAt!,
    durationMinutes: Math.round(r.durationSeconds / 60),
    venue: r.venue,
  }));
}
