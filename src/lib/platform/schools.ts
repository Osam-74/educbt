/**
 * Tenant lifecycle services — the platform administration business logic.
 *
 * WHAT THIS IS: the only code path through which a school is created,
 * given its first principal, suspended and reactivated. Pages under
 * src/app/platform present results from here; they never re-decide a rule.
 *
 * SECURITY MODEL, in the order it actually matters:
 *
 *   1. Role check FIRST, before any database work: only platform_admin may
 *      call anything here. A principal, teacher or student passing a fake
 *      actor is refused before a connection is even touched.
 *   2. All cross-tenant work runs inside asPlatformAdmin() — the audited
 *      elevation that sets `app.platform_admin = 'on'` for exactly one
 *      transaction. No owner credentials, no RLS bypass, nothing global
 *      outside that boundary.
 *   3. The transaction wraps school + principal + staff + audit together.
 *      A half-built tenant is impossible: if the principal step fails the
 *      school vanishes with it.
 *
 * THE TRANSACTION LESSON, applied: Argon2 hashing runs BEFORE the
 * transaction opens. The runtime pool is max:1 — holding the one pooled
 * connection through a 50ms hash would queue every other request behind it,
 * and that is exactly how the startAttempt deadlock happened.
 *
 * PASSWORD HANDLING: the temporary password is generated in memory, hashed
 * with Argon2id, returned ONCE to the caller (which shows it once), and never
 * stored, logged, or written into any audit JSON.
 */

import { and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { asPlatformAdmin, schema, type Tx } from '@/db';
import { hashPassword, generateInitialPassword } from '@/lib/auth/password';
import type { PlatformActor } from '@/lib/platform/session';

// ── Errors the UI can render as-is ───────────────────────────────────────────
// Plain, school-administrator language. No database terminology ever reaches
// a user: constraint violations are mapped here, at the service boundary.

export class PlatformPermissionError extends Error {
  constructor() {
    super('Only platform administrators may perform this action.');
  }
}

export class OnboardingValidationError extends Error {
  constructor(public readonly fieldErrors: Record<string, string>) {
    super('Please correct the highlighted fields.');
  }
}

export class DuplicateValueError extends Error {
  constructor(public readonly field: string, message: string) {
    super(message);
  }
}

export class NotFoundError extends Error {
  constructor(message = 'That school could not be found.') {
    super(message);
  }
}

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Subdomains become real hostnames once the owner configures wildcard DNS
 * (deliberately NOT a dependency of this flow). The same rules a registrar
 * would apply: lowercase, no leading/trailing hyphen, sane length, and none
 * of the names the platform itself needs.
 */
const RESERVED_SUBDOMAINS = new Set([
  'www', 'app', 'api', 'admin', 'portal', 'platform', 'dashboard', 'mail',
  'smtp', 'ftp', 'auth', 'docs', 'status', 'support', 'static', 'assets',
  'cdn', 'dev', 'test', 'staging', 'beta', 'demo', 'inngest', 'backup',
]);

const subdomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])?$/, 'Use only letters, numbers and hyphens.')
  .refine((s) => !RESERVED_SUBDOMAINS.has(s), 'That address is reserved for the platform itself.');

const schoolCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9-]{1,49}$/, 'Use 2–50 letters, numbers or hyphens.');

const nameSchema = z
  .string()
  .trim()
  .min(3, 'Enter the full name of the school.')
  .max(191, 'That name is too long.');

const optionalContactSchema = z
  .string()
  .trim()
  .max(191, 'That entry is too long.')
  .optional()
  .transform((v) => (v === '' ? undefined : v));

const onboardingSchema = z.object({
  name: nameSchema,
  code: schoolCodeSchema,
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(191, 'That email address is too long.')
    .optional()
    .transform((v) => (v === '' ? undefined : v))
    .refine((v) => v === undefined || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), {
      message: 'Enter a valid email address, or leave it empty.',
    }),
  phone: z
    .string()
    .trim()
    .max(50, 'That phone number is too long.')
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
  address: z
    .string()
    .trim()
    .max(500, 'That address is too long.')
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
  subdomain: subdomainSchema.optional().transform((v) => (v === '' ? undefined : v)),
  status: z.enum(['active', 'suspended']).default('active'),
  principalFirstName: z
    .string()
    .trim()
    .min(2, 'Enter the principal’s first name.')
    .max(100, 'That name is too long.'),
  principalLastName: z
    .string()
    .trim()
    .min(2, 'Enter the principal’s last name.')
    .max(100, 'That name is too long.'),
  principalLoginId: z
    .string()
    .trim()
    .min(3, 'Enter a sign-in ID for the principal (usually their email address).')
    .max(191, 'That sign-in ID is too long.'),
});

export type OnboardingInput = z.input<typeof onboardingSchema>;
export type ValidatedOnboarding = z.output<typeof onboardingSchema>;

const statusChangeSchema = z.object({
  schoolId: z.coerce.number().int().positive(),
  status: z.enum(['active', 'suspended']),
  reason: z.string().trim().min(10, 'Give a short reason for the record (at least 10 characters).').max(500),
  confirm: z.coerce.boolean(),
});

// ── Guards ─────────────────────────────────────────────────────────────────────

/**
 * Runtime role check at every service entry.
 *
 * Routes already refuse non-platform sessions (requirePlatformSession), but
 * the service is the security boundary for its own rules: it re-verifies the
 * caller's role before ANY database work, so a principal, teacher or student
 * actor — however it was constructed — is refused before a connection is
 * touched. The check is not a duplicate: the route guard can be forgotten
 * when a new page is added; this one cannot.
 */
function assertPlatformAdmin(actor: PlatformActor): void {
  if (actor.role !== 'platform_admin') throw new PlatformPermissionError();
}

// ── Shared transaction body ──────────────────────────────────────────────────

/**
 * The principal-creation half of onboarding, inside the caller's platform
 * transaction. Kept separate so a school that already exists (rare recovery
 * paths, tests) can be given its first administrator with the SAME rules —
 * one code path, no drift.
 */
async function onboardPrincipalInTx(
  tx: Tx,
  schoolId: number,
  input: ValidatedOnboarding,
  passwordHash: string,
  actorUserId: number,
): Promise<{ principalUserId: number; principalName: string }> {
  const [principalUser] = await tx
    .insert(schema.users)
    .values({
      schoolId,
      role: 'principal',
      loginId: input.principalLoginId,
      passwordHash,
      // The temporary password must be replaced at first sign-in.
      mustChangePassword: true,
      status: 'active',
    })
    .returning({ id: schema.users.id, loginId: schema.users.loginId });

  await tx.insert(schema.staff).values({
    schoolId,
    userId: principalUser!.id,
    // Deterministic, and unique per school (fresh school ⇒ no collision).
    staffNumber: 'PRN-0001',
    firstName: input.principalFirstName,
    lastName: input.principalLastName,
    email: input.email,
    role: 'principal',
    status: 'active',
  });

  const principalName = `${input.principalFirstName} ${input.principalLastName}`;

  await tx.insert(schema.auditLog).values({
    schoolId,
    actorUserId,
    actorRole: 'platform_admin',
    action: 'school.principal_created',
    entityType: 'users',
    entityId: Number(principalUser!.id),
    after: {
      loginId: input.principalLoginId,
      name: principalName,
      role: 'principal',
      temporaryPasswordIssued: true, // the value itself is never recorded
    },
  });

  return { principalUserId: Number(principalUser!.id), principalName };
}

// ── School creation ───────────────────────────────────────────────────────────

export type OnboardedSchool = {
  school: {
    id: number;
    name: string;
    code: string;
    subdomain: string | null;
    status: string;
  };
  principal: {
    name: string;
    loginId: string;
  };
  /**
   * The one-time temporary password. Returned to the caller exactly once so
   * the platform admin can hand it over; it is not stored anywhere else.
   */
  temporaryPassword: string;
};

export async function createSchoolWithPrincipal(
  actor: PlatformActor,
  rawInput: OnboardingInput,
): Promise<OnboardedSchool> {
  assertPlatformAdmin(actor);
  const parsed = onboardingSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new OnboardingValidationError(
      Object.fromEntries(
        parsed.error.issues.map((issue) => [issue.path[0] ?? 'form', issue.message]),
      ),
    );
  }
  const input = parsed.data;

  // Cryptographically secure, human-typeable. Hashed OUTSIDE the transaction —
  // Argon2 must never hold the single pooled connection hostage.
  const temporaryPassword = generateInitialPassword(12);
  const passwordHash = await hashPassword(temporaryPassword);

  const reason = `Onboard school ${input.name} (${input.code})`;

  try {
    return await asPlatformAdmin(actor.userId, reason, async (tx) => {
      const [school] = await tx
        .insert(schema.schools)
        .values({
          name: input.name,
          code: input.code,
          subdomain: input.subdomain ?? null,
          email: input.email ?? null,
          phone: input.phone ?? null,
          address: input.address ?? null,
          status: input.status,
        })
        .returning({
          id: schema.schools.id,
          name: schema.schools.name,
          code: schema.schools.code,
          subdomain: schema.schools.subdomain,
          status: schema.schools.status,
        });

      const { principalName } = await onboardPrincipalInTx(
        tx,
        Number(school!.id),
        input,
        passwordHash,
        actor.userId,
      );

      await tx.insert(schema.auditLog).values({
        schoolId: Number(school!.id),
        actorUserId: actor.userId,
        actorRole: 'platform_admin',
        action: 'school.created',
        entityType: 'schools',
        entityId: Number(school!.id),
        after: {
          name: input.name,
          code: input.code,
          subdomain: input.subdomain ?? null,
          status: input.status,
          email: input.email ?? null,
          phone: input.phone ?? null,
        },
      });

      return {
        school: {
          id: Number(school!.id),
          name: school!.name,
          code: school!.code,
          subdomain: school!.subdomain,
          status: school!.status,
        },
        principal: { name: principalName, loginId: input.principalLoginId },
        temporaryPassword,
      };
    });
  } catch (error) {
    throw mapDuplicate(error);
  }
}

/**
 * Give an EXISTING school its first (or replacement) principal. Not exposed in
 * the first UI pass — it exists so the same rules serve recovery and tests,
 * instead of a second, drifting code path.
 */
export async function createPrincipalForSchool(
  actor: PlatformActor,
  schoolId: number,
  rawInput: OnboardingInput,
): Promise<{ principalName: string; temporaryPassword: string }> {
  assertPlatformAdmin(actor);
  const parsed = onboardingSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new OnboardingValidationError(
      Object.fromEntries(
        parsed.error.issues.map((issue) => [issue.path[0] ?? 'form', issue.message]),
      ),
    );
  }
  const input = parsed.data;

  const temporaryPassword = generateInitialPassword(12);
  const passwordHash = await hashPassword(temporaryPassword);

  const reason = `Appoint principal for school #${schoolId}`;

  try {
    return await asPlatformAdmin(actor.userId, reason, async (tx) => {
      const [school] = await tx
        .select({ id: schema.schools.id })
        .from(schema.schools)
        .where(eq(schema.schools.id, schoolId))
        .limit(1);
      if (!school) throw new NotFoundError();

      const { principalName } = await onboardPrincipalInTx(
        tx,
        Number(school.id),
        input,
        passwordHash,
        actor.userId,
      );
      return { principalName, temporaryPassword };
    });
  } catch (error) {
    throw mapDuplicate(error);
  }
}

// ── Status lifecycle ─────────────────────────────────────────────────────────

export async function setSchoolStatus(
  actor: PlatformActor,
  rawInput: z.input<typeof statusChangeSchema>,
): Promise<{ schoolId: number; status: 'active' | 'suspended' }> {
  assertPlatformAdmin(actor);
  const parsed = statusChangeSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new OnboardingValidationError(
      Object.fromEntries(
        parsed.error.issues.map((issue) => [issue.path[0] ?? 'form', issue.message]),
      ),
    );
  }
  const { schoolId, status, reason, confirm } = parsed.data;

  if (!confirm) {
    throw new OnboardingValidationError({ confirm: 'Tick the confirmation box to proceed.' });
  }

  const auditedReason = `School #${schoolId} → ${status}: ${reason}`;

  return asPlatformAdmin(actor.userId, auditedReason, async (tx) => {
    const [school] = await tx
      .select({ id: schema.schools.id, status: schema.schools.status, name: schema.schools.name })
      .from(schema.schools)
      .where(eq(schema.schools.id, schoolId))
      .limit(1);

    if (!school) throw new NotFoundError();

    if (school.status === status) {
      throw new OnboardingValidationError({
        status: `This school is already ${status === 'active' ? 'active' : 'suspended'}.`,
      });
    }

    await tx
      .update(schema.schools)
      .set({ status, updatedAt: new Date() })
      .where(eq(schema.schools.id, schoolId));

    await tx.insert(schema.auditLog).values({
      schoolId,
      actorUserId: actor.userId,
      actorRole: 'platform_admin',
      // The three events the audit standard names: activation of a brand-new
      // school is covered by school.created; a suspension and its reversal
      // each get their own, distinct action.
      action: status === 'suspended' ? 'school.suspended' : 'school.reactivated',
      entityType: 'schools',
      entityId: schoolId,
      before: { status: school.status },
      after: { status },
      reason: `${reason}`,
    });

    return { schoolId, status };
  });
}

// ── Reads ──────────────────────────────────────────────────────────────────────

export type SchoolSummary = {
  id: number;
  name: string;
  code: string;
  status: string;
  subdomain: string | null;
  email: string | null;
  phone: string | null;
  createdAt: Date;
  principalName: string | null;
  principalLoginId: string | null;
  principalStatus: string | null;
};

/**
 * Platform-wide school directory. Deliberately tenant metadata only — no
 * student counts, no exam records, nothing a tenant-scope query would answer.
 */
export async function listSchools(
  actor: PlatformActor,
  opts: { search?: string; status?: string } = {},
  readReason = 'View platform school directory',
): Promise<SchoolSummary[]> {
  assertPlatformAdmin(actor);
  return asPlatformAdmin(actor.userId, readReason, async (tx) => {
    const filters = [];
    const term = opts.search?.trim();
    if (term) {
      filters.push(
        or(
          ilike(schema.schools.name, `%${term}%`),
          ilike(schema.schools.code, `%${term.toUpperCase()}%`),
          ilike(schema.schools.subdomain, `%${term.toLowerCase()}%`),
        ),
      );
    }
    if (opts.status && ['active', 'suspended', 'archived'].includes(opts.status)) {
      filters.push(eq(schema.schools.status, opts.status as 'active' | 'suspended' | 'archived'));
    }

    const schools = await tx
      .select({
        id: schema.schools.id,
        name: schema.schools.name,
        code: schema.schools.code,
        status: schema.schools.status,
        subdomain: schema.schools.subdomain,
        email: schema.schools.email,
        phone: schema.schools.phone,
        createdAt: schema.schools.createdAt,
      })
      .from(schema.schools)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(schema.schools.createdAt))
      .limit(200);

    if (schools.length === 0) return [];

    // The initial administrator for each school — one query, not N+1.
    const principals = await tx
      .select({
        schoolId: schema.users.schoolId,
        loginId: schema.users.loginId,
        status: schema.users.status,
        firstName: schema.staff.firstName,
        lastName: schema.staff.lastName,
      })
      .from(schema.users)
      .innerJoin(schema.staff, eq(schema.staff.userId, schema.users.id))
      .where(
        and(
          eq(schema.users.role, 'principal'),
          inArray(
            schema.users.schoolId,
            schools.map((s) => Number(s.id)),
          ),
        ),
      );

    const bySchool = new Map(
      principals.map((p) => [Number(p.schoolId), p]),
    );

    return schools.map((s) => {
      const p = bySchool.get(Number(s.id));
      return {
        ...s,
        id: Number(s.id),
        createdAt: s.createdAt,
        principalName: p ? `${p.firstName} ${p.lastName}` : null,
        principalLoginId: p?.loginId ?? null,
        principalStatus: p?.status ?? null,
      };
    });
  });
}

export type PlatformOverview = {
  total: number;
  active: number;
  suspended: number;
  archived: number;
  recent: { id: number; name: string; code: string; status: string; createdAt: Date }[];
};

/** Dashboard: tenant counts and the newest schools. Tenant metadata only. */
export async function platformOverview(
  actor: PlatformActor,
  readReason = 'Platform dashboard overview',
): Promise<PlatformOverview> {
  assertPlatformAdmin(actor);
  return asPlatformAdmin(actor.userId, readReason, async (tx) => {
    const counts = await tx
      .select({ status: schema.schools.status, n: sql<number>`count(*)::int` })
      .from(schema.schools)
      .groupBy(schema.schools.status);

    const by = (s: string) => Number(counts.find((c) => c.status === s)?.n ?? 0);

    const recent = await tx
      .select({
        id: schema.schools.id,
        name: schema.schools.name,
        code: schema.schools.code,
        status: schema.schools.status,
        createdAt: schema.schools.createdAt,
      })
      .from(schema.schools)
      .orderBy(desc(schema.schools.createdAt))
      .limit(5);

    return {
      total: counts.reduce((sum, c) => sum + Number(c.n), 0),
      active: by('active'),
      suspended: by('suspended'),
      archived: by('archived'),
      recent: recent.map((r) => ({ ...r, id: Number(r.id) })),
    };
  });
}

export type SchoolDetail = SchoolSummary & {
  address: string | null;
  updatedAt: Date;
  setup: {
    academicSessions: number;
    classes: number;
    subjects: number;
    students: number;
    staff: number;
  };
};

/**
 * One school's platform record. The "academic setup" figures are COUNTS —
 * enough to see whether onboarding finished, never a window into names,
 * marks or records that belong to the school.
 */
export async function schoolDetail(
  actor: PlatformActor,
  schoolId: number,
  readReason?: string,
): Promise<SchoolDetail> {
  assertPlatformAdmin(actor);
  const reason = readReason ?? `Review school #${schoolId} before a platform action`;

  return asPlatformAdmin(actor.userId, reason, async (tx) => {
    const [school] = await tx
      .select()
      .from(schema.schools)
      .where(eq(schema.schools.id, schoolId))
      .limit(1);

    if (!school) throw new NotFoundError();

    const [principal] = await tx
      .select({
        loginId: schema.users.loginId,
        status: schema.users.status,
        firstName: schema.staff.firstName,
        lastName: schema.staff.lastName,
      })
      .from(schema.users)
      .leftJoin(schema.staff, eq(schema.staff.userId, schema.users.id))
      .where(and(eq(schema.users.schoolId, schoolId), eq(schema.users.role, 'principal')))
      .limit(1);

    // Five scalar counts in one round trip. Rows, not objects: postgres.js
    // returns the SELECT result as an array of records.
    const setupRows = await tx.execute<{
      sessions: number; classes: number; subjects: number; students: number; staff: number;
    }>(sql`
      SELECT
        (SELECT count(*)::int FROM academic_sessions WHERE school_id = ${schoolId}) AS sessions,
        (SELECT count(*)::int FROM classes WHERE school_id = ${schoolId}) AS classes,
        (SELECT count(*)::int FROM subjects WHERE school_id = ${schoolId}) AS subjects,
        (SELECT count(*)::int FROM students WHERE school_id = ${schoolId}) AS students,
        (SELECT count(*)::int FROM staff WHERE school_id = ${schoolId}) AS staff
    `);
    const setup = setupRows[0];

    return {
      id: Number(school.id),
      name: school.name,
      code: school.code,
      status: school.status,
      subdomain: school.subdomain,
      email: school.email,
      phone: school.phone,
      address: school.address,
      createdAt: school.createdAt,
      updatedAt: school.updatedAt,
      principalName: principal ? `${principal.firstName ?? ''} ${principal.lastName ?? ''}`.trim() || null : null,
      principalLoginId: principal?.loginId ?? null,
      principalStatus: principal?.status ?? null,
      setup: {
        academicSessions: Number(setup?.sessions ?? 0),
        classes: Number(setup?.classes ?? 0),
        subjects: Number(setup?.subjects ?? 0),
        students: Number(setup?.students ?? 0),
        staff: Number(setup?.staff ?? 0),
      },
    };
  });
}

// ── Error mapping ─────────────────────────────────────────────────────────────

/**
 * Raw uniqueness violations are a leak of database internals; users get
 * plain language instead. The pre-check is the database itself — unique
 * indexes — and this mapping makes their errors humane, including the race
 * where two platform admins onboard at once.
 */
function mapDuplicate(error: unknown): Error {
  const e = error as { code?: string; message?: string };
  if (e?.code !== '23505') return error instanceof Error ? error : new Error(String(error));

  const msg = e.message ?? '';
  if (msg.includes('schools_code_uq')) {
    return new DuplicateValueError('code', 'That school code is already in use.');
  }
  if (msg.includes('schools_subdomain_uq')) {
    return new DuplicateValueError('subdomain', 'That school address is already in use.');
  }
  if (msg.includes('users_school_login_uq')) {
    return new DuplicateValueError('principalLoginId', 'That sign-in ID is already used at this school.');
  }
  if (msg.includes('staff_school_number_uq')) {
    return new DuplicateValueError(
      'principal',
      'This school already has an administrator on record. Contact support before adding another.',
    );
  }
  return new DuplicateValueError('form', 'A required detail is already in use. Please review and try again.');
}
