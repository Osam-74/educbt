/**
 * Academic transcripts (legacy EduCBT Pro parity).
 *
 * Legacy reference: includes/Services/TranscriptService.php. A transcript is an
 * ISSUED document, not a live view: it compiles only PUBLISHED results from
 * every session and term the student has on record, is sealed with a serial,
 * and every copy that leaves the school is logged. Report sheets are progress
 * for the parent; transcripts are verification for another institution — no
 * behavioural remarks travel with them, and an unapproved mark must never
 * leave the school inside an official document.
 *
 * What is deliberately preserved from the legacy service:
 *   - compile groups sessions newest-first, terms in order within a session;
 *   - only published results, never drafts or reviewed-but-unpublished;
 *   - the serial format SCHOOLCODE/TR/YYYY/NNNN, unique across the platform;
 *   - issuance is recorded BEFORE anything is rendered — a failed render still
 *     leaves a trace that a transcript was requested;
 *   - the second and later issues are marked 'reissued' (the first stays
 *     visible in history), and any copy can be revoked with a reason;
 *   - a snapshot of terms recorded + cumulative average is stored with the
 *     issue, so later questions about drift have an answer on file.
 *
 * What is NOT copied: the legacy checksum. It was a sha256 slice salted with
 * wp_salt — verifiable only by staff with database access, and the QR linked to
 * a public page that trusted the serial alone. Here the printed document
 * carries serial + verification code, where the code is HMAC-SHA256(server
 * secret, serial). The secret never leaves the server, the code cannot be
 * enumerated or forged for serials the holder doesn't have, and the public
 * verify page checks BOTH before saying anything about the document.
 */

import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { forSchool, schema, type Tx } from '@/db';
import type { Actor } from '@/lib/session';
import { DEFAULT_RANKING, rank } from '@/domain/academic';

export class TranscriptError extends Error {}
const fail = (message: string): never => { throw new TranscriptError(message); };

/** Legacy: ISSUE_TRANSCRIPT belongs to the principal alone — the document is
 *  sealed, serialised and speaks for the school to the outside world. */
export function canIssueTranscript(actor: Actor): boolean {
  return actor.role === 'principal';
}

const VERIFY_SECRET = () => process.env.TRANSCRIPT_VERIFY_SECRET ?? '';

export function verificationAvailable(): boolean {
  return VERIFY_SECRET().length >= 16;
}

/** The code printed on the document: 10 hex chars of HMAC(secret, serial).
 *  Derived, never stored — a database dump cannot produce valid codes. */
export function verificationCode(serial: string): string {
  return createHmac('sha256', VERIFY_SECRET()).update(`transcript:${serial}`).digest('hex').slice(0, 10);
}

export function verifyCode(serial: string, code: string): boolean {
  if (!verificationAvailable() || !/^[0-9a-f]{10}$/.test(code)) return false;
  const expected = Buffer.from(verificationCode(serial), 'hex');
  const given = Buffer.from(code, 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export type TranscriptSubject = { name: string; code: string; score: number; grade: string };
export type TranscriptTerm = { term: string; subjects: TranscriptSubject[]; average: number; position: number; classSize: number };
export type TranscriptSession = { session: string; className: string | null; terms: TranscriptTerm[] };
export type CompiledTranscript = {
  found: boolean;
  sessions: TranscriptSession[];
  termsRecorded: number;
  cumulativeAverage: number;
  student: {
    name: string; admissionNumber: string; gender: string | null;
    dateOfBirth: Date | null; photoUrl: string | null; status: string;
  } | null;
};

/**
 * Assemble a student's full academic history from published results only.
 * Sessions descend from the most recent; terms within a session ascend — the
 * order a reader actually scans a transcript.
 */
export async function compileTranscript(tx: Tx, schoolId: number, studentId: number): Promise<CompiledTranscript> {
  const [student] = await tx.select({
    firstName: schema.students.firstName, lastName: schema.students.lastName,
    admissionNumber: schema.students.admissionNumber, gender: schema.students.gender,
    dateOfBirth: schema.students.dateOfBirth, photoUrl: schema.students.photoUrl,
    status: schema.students.status,
  }).from(schema.students).where(and(eq(schema.students.id, studentId), eq(schema.students.schoolId, schoolId)));
  if (!student) return { found: false, sessions: [], termsRecorded: 0, cumulativeAverage: 0, student: null };

  // Only PUBLISHED results appear. An unapproved mark must never leave the
  // school inside an official document.
  const rows = await tx.select({
    sessionId: schema.subjectResults.sessionId,
    termId: schema.subjectResults.termId,
    subjectName: schema.subjects.name,
    subjectCode: schema.subjects.code,
    total: schema.subjectResults.total,
    grade: schema.subjectResults.grade,
  }).from(schema.subjectResults)
    .innerJoin(schema.subjects, eq(schema.subjects.id, schema.subjectResults.subjectId))
    .where(and(
      eq(schema.subjectResults.schoolId, schoolId),
      eq(schema.subjectResults.studentId, studentId),
      eq(schema.subjectResults.published, true),
    )).orderBy(asc(schema.subjects.name));

  const sessions = await tx.select({
    id: schema.academicSessions.id, title: schema.academicSessions.title, startsOn: schema.academicSessions.startsOn,
  }).from(schema.academicSessions).where(eq(schema.academicSessions.schoolId, schoolId));

  const terms = await tx.select({
    id: schema.terms.id, sessionId: schema.terms.sessionId, title: schema.terms.title, position: schema.terms.position,
  }).from(schema.terms).where(eq(schema.terms.schoolId, schoolId));

  // The class the student sat in for each session (historical enrollments are
  // never overwritten, so this is the true history).
  const enrollments = await tx.select({
    sessionId: schema.enrollments.sessionId, className: schema.classes.displayName, classId: schema.enrollments.classId,
  }).from(schema.enrollments)
    .innerJoin(schema.classes, eq(schema.classes.id, schema.enrollments.classId))
    .where(and(
      eq(schema.enrollments.schoolId, schoolId),
      eq(schema.enrollments.studentId, studentId),
      eq(schema.enrollments.status, 'active'),
    ));

  // Position per term: rank the student against classmates by term average,
  // with the school's default ranking policy — the same competition the term
  // report uses, so the two documents can never disagree about standing.
  const termCohort = new Map<string, Array<{ studentId: number; total: number }>>(); // "class:session:term"
  for (const e of enrollments) {
    const scopeKey = `${e.classId}:${e.sessionId}`;
    if ([...termCohort.keys()].some(k => k.startsWith(scopeKey + ':'))) continue;
    const mates = await tx.select({ studentId: schema.enrollments.studentId })
      .from(schema.enrollments)
      .where(and(
        eq(schema.enrollments.schoolId, schoolId),
        eq(schema.enrollments.sessionId, e.sessionId),
        eq(schema.enrollments.classId, e.classId),
        eq(schema.enrollments.status, 'active'),
      ));
    if (mates.length <= 1) continue;
    const mateResults = await tx.select({
      termId: schema.subjectResults.termId, studentId: schema.subjectResults.studentId, total: schema.subjectResults.total,
    }).from(schema.subjectResults).where(and(
      eq(schema.subjectResults.schoolId, schoolId),
      inArray(schema.subjectResults.studentId, mates.map(m => m.studentId)),
      eq(schema.subjectResults.sessionId, e.sessionId),
      eq(schema.subjectResults.published, true),
    ));
    const perStudent = new Map<number, Map<number, number[]>>();
    for (const r of mateResults) {
      const byTerm = perStudent.get(r.studentId) ?? new Map<number, number[]>();
      const list = byTerm.get(r.termId) ?? [];
      list.push(Number(r.total));
      byTerm.set(r.termId, list);
      perStudent.set(r.studentId, byTerm);
    }
    for (const [studentId, byTerm] of perStudent) {
      for (const [termId, totals] of byTerm) {
        const key = `${scopeKey}:${termId}`;
        const list = termCohort.get(key) ?? [];
        list.push({ studentId, total: totals.reduce((s, n) => s + n, 0) / totals.length });
        termCohort.set(key, list);
      }
    }
  }

  // Group into sessions (newest first), each holding ordered terms.
  const grouped = new Map<number, TranscriptSession>();
  for (const session of [...sessions].sort((a, b) =>
    (b.startsOn?.getTime() ?? 0) - (a.startsOn?.getTime() ?? 0) || b.title.localeCompare(a.title))) {
    grouped.set(session.id, { session: session.title, className: enrollments.find(e => e.sessionId === session.id)?.className ?? null, terms: [] });
  }

  const byTermRows = new Map<number, TranscriptSubject[]>();
  for (const row of rows) {
    const list = byTermRows.get(row.termId) ?? [];
    list.push({ name: row.subjectName, code: row.subjectCode, score: Number(row.total), grade: row.grade });
    byTermRows.set(row.termId, list);
  }

  const termAverages: number[] = [];
  for (const term of [...terms].sort((a, b) => a.position - b.position)) {
    const subjects = byTermRows.get(term.id);
    if (!subjects?.length) continue;
    const host = grouped.get(term.sessionId);
    if (!host) continue;
    const average = subjects.reduce((s, n) => s + n.score, 0) / subjects.length;
    const enrollment = enrollments.find(e => e.sessionId === term.sessionId);
    let position = 0;
    let classSize = 0;
    if (enrollment) {
      const cohort = termCohort.get(`${enrollment.classId}:${term.sessionId}:${term.id}`) ?? [];
      if (cohort.length) {
        const ranked = rank(cohort, DEFAULT_RANKING);
        const mine = ranked.find(r => r.studentId === studentId);
        position = mine?.position ?? 0;
        classSize = cohort.length;
      }
    }
    host.terms.push({ term: term.title, subjects, average: Math.round(average * 10) / 10, position, classSize });
    termAverages.push(average);
  }

  const out: TranscriptSession[] = [];
  for (const session of grouped.values()) if (session.terms.length) out.push(session);

  return {
    found: termAverages.length > 0,
    sessions: out,
    termsRecorded: termAverages.length,
    cumulativeAverage: termAverages.length ? Math.round(termAverages.reduce((s, n) => s + n, 0) / termAverages.length * 100) / 100 : 0,
    student: {
      name: `${student.firstName} ${student.lastName}`.trim(),
      admissionNumber: student.admissionNumber,
      gender: student.gender,
      dateOfBirth: student.dateOfBirth,
      photoUrl: student.photoUrl,
      status: student.status,
    },
  };
}

/** The document data for a student (principal view): history + snapshot inputs. */
export async function transcriptData(actor: Actor, studentId: number) {
  if (!canIssueTranscript(actor)) fail('Only the principal may prepare transcripts.');
  return forSchool(actor.schoolId, async tx => compileTranscript(tx, actor.schoolId, studentId));
}

/** GRE001/TR/2026/0007 — school, document type, year, sequence. */
async function nextSerial(tx: Tx, schoolId: number): Promise<string> {
  const [school] = await tx.select({ code: schema.schools.code }).from(schema.schools).where(eq(schema.schools.id, schoolId));
  const prefix = `${(school?.code || 'SCH').toUpperCase()}/TR/${new Date().getFullYear()}/`;
  const recent = await tx.select({ serial: schema.transcripts.serial }).from(schema.transcripts)
    .where(eq(schema.transcripts.schoolId, schoolId))
    .orderBy(desc(schema.transcripts.id)).limit(200);
  let sequence = 1;
  for (const row of recent) {
    if (row.serial.startsWith(prefix)) {
      const match = row.serial.match(/(\d+)$/);
      if (match) sequence = Number(match[1]) + 1;
      break;
    }
  }
  return prefix + String(sequence).padStart(4, '0');
}

/**
 * Issue a transcript: record it (with serial and snapshot), then hand the
 * caller the serial to render. Issuance is recorded BEFORE rendering — if the
 * render fails, the school still has a record that a transcript was requested.
 */
export async function issueTranscript(actor: Actor, studentId: number, purpose = '') {
  if (!canIssueTranscript(actor)) fail('Only the principal may issue transcripts.');
  const trimmed = purpose.trim().slice(0, 255);

  return forSchool(actor.schoolId, async tx => {
    const compiled = await compileTranscript(tx, actor.schoolId, studentId);
    if (!compiled.found || !compiled.student) fail('This student has no published results to transcribe.');

    const prior = await tx.select({ id: schema.transcripts.id }).from(schema.transcripts)
      .where(and(
        eq(schema.transcripts.schoolId, actor.schoolId),
        eq(schema.transcripts.studentId, studentId),
        inArray(schema.transcripts.status, ['issued', 'reissued']),
      ));
    const issueStatus = prior.length > 0 ? 'reissued' : 'issued';

    const serial = await nextSerial(tx, actor.schoolId);

    const [row] = await tx.insert(schema.transcripts).values({
      schoolId: actor.schoolId,
      studentId,
      serial,
      purpose: trimmed,
      termsRecorded: compiled.termsRecorded,
      cumulativeAverage: String(compiled.cumulativeAverage),
      issuedBy: actor.userId,
      status: issueStatus,
    }).returning();

    await tx.insert(schema.auditLog).values({
      schoolId: actor.schoolId, actorUserId: actor.userId, actorRole: actor.role,
      action: 'transcript.issued', entityType: 'transcript',
      before: null,
      after: { transcriptId: row!.id, serial, studentId, status: issueStatus, termsRecorded: compiled.termsRecorded, cumulativeAverage: compiled.cumulativeAverage },
    });

    return { id: row!.id, serial, status: issueStatus };
  });
}

/** Revoke a transcript issued in error, so a later verification can say so. */
export async function revokeTranscript(actor: Actor, serial: string, reason: string) {
  if (!canIssueTranscript(actor)) fail('Only the principal may revoke transcripts.');
  const trimmed = reason.trim();
  if (trimmed.length < 10 || trimmed.length > 255) fail('Provide a written revocation reason of at least 10 characters.');

  return forSchool(actor.schoolId, async tx => {
    const [row] = await tx.select().from(schema.transcripts)
      .where(and(eq(schema.transcripts.serial, serial.trim()), eq(schema.transcripts.schoolId, actor.schoolId)));
    if (!row) fail('That transcript serial does not exist in this school.');
    if (row!.status === 'revoked') fail('That transcript is already revoked.');

    await tx.update(schema.transcripts).set({
      status: 'revoked', revokeReason: trimmed, revokedBy: actor.userId, revokedAt: new Date(),
    }).where(eq(schema.transcripts.id, row!.id));

    await tx.insert(schema.auditLog).values({
      schoolId: actor.schoolId, actorUserId: actor.userId, actorRole: actor.role,
      action: 'transcript.revoked', entityType: 'transcript',
      before: { serial, status: row!.status },
      after: { serial, status: 'revoked' },
      reason: trimmed,
    });

    return { ok: true };
  });
}

/** Every copy ever issued for a student — traceable to who issued it, when, why. */
export async function transcriptHistory(actor: Actor, studentId: number) {
  if (!canIssueTranscript(actor)) fail('Only the principal may view transcript history.');
  return forSchool(actor.schoolId, async tx => {
    const [student] = await tx.select({
      firstName: schema.students.firstName, lastName: schema.students.lastName,
      admissionNumber: schema.students.admissionNumber, status: schema.students.status, id: schema.students.id,
    }).from(schema.students).where(and(eq(schema.students.id, studentId), eq(schema.students.schoolId, actor.schoolId)));
    if (!student) fail('That student is not in this school.');

    const rows = await tx.select().from(schema.transcripts)
      .where(and(eq(schema.transcripts.schoolId, actor.schoolId), eq(schema.transcripts.studentId, studentId)))
      .orderBy(desc(schema.transcripts.issuedAt));
    return { student, transcripts: rows };
  });
}

/** The issued document for the print view (principal only). */
export async function transcriptBySerial(actor: Actor, serial: string) {
  if (!canIssueTranscript(actor)) fail('Only the principal may view issued transcripts.');
  return forSchool(actor.schoolId, async tx => {
    const [row] = await tx.select().from(schema.transcripts)
      .where(and(eq(schema.transcripts.serial, serial.trim()), eq(schema.transcripts.schoolId, actor.schoolId)));
    if (!row) fail('That transcript does not exist.');
    const compiled = await compileTranscript(tx, actor.schoolId, row!.studentId);
    const [school] = await tx.select({
      name: schema.schools.name, address: schema.schools.address, phone: schema.schools.phone,
      email: schema.schools.email, website: schema.schools.website, logoUrl: schema.schools.logoUrl,
      principalName: schema.schools.principalName,
    }).from(schema.schools).where(eq(schema.schools.id, actor.schoolId));
    return { transcript: row!, compiled, school };
  });
}
