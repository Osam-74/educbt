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
import { seedStandardSubjects } from '@/lib/subjects/service';
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

/**
 * The short prefix that actually appears on an ID (KC/26/0412, KC/SF/0018) —
 * NOT the long `code` above, which is a permanent platform reference the
 * school never sees on a card. Default: initials of the school name's first
 * two words. A school whose name only ever gives one usable word (rare, but
 * "Academy" alone happens) falls back to that word's own first two letters.
 */
export function deriveIdPrefixWords(name: string): string[] {
  return name.trim().split(/\s+/).map((w) => w.replace(/[^A-Za-z]/g, '')).filter(Boolean);
}

/**
 * Candidate prefixes in preference order: the natural 2-letter initials
 * first, then progressively less-natural 3-letter extensions, so a
 * colliding school gets a THIRD letter added rather than a completely
 * different scheme. Numbered fallback only if a school runs out of letters
 * entirely (effectively never).
 */
export function* candidateIdPrefixes(name: string): Generator<string> {
  const words = deriveIdPrefixWords(name);
  if (words.length === 0) { yield 'SCH'; return; }

  const base2 = words.length >= 2
    ? (words[0]![0]! + words[1]![0]!).toUpperCase()
    : words[0]!.slice(0, 2).toUpperCase().padEnd(2, 'X');
  yield base2;

  if (words.length >= 3) yield (words[0]![0]! + words[1]![0]! + words[2]![0]!).toUpperCase();

  const second = words[1] ?? words[0]!;
  for (let i = 1; i < second.length && i <= 4; i += 1) yield base2 + second[i]!.toUpperCase();

  const first = words[0]!;
  for (let i = 1; i < first.length && i <= 4; i += 1) yield base2 + first[i]!.toUpperCase();

  for (let n = 2; n <= 99; n += 1) yield `${base2}${n}`;
}

/**
 * Resolve a school's ID prefix inside the onboarding transaction: an
 * explicit choice wins outright (a school already running its own scheme
 * types it in, same idea as a student's custom admission number); otherwise
 * the first non-colliding candidate from the name is used. Checked against
 * every school on the platform, not just this tenant — two different
 * schools both minting "KC/26/0412" would be worse than a slightly odd
 * three-letter prefix.
 */
export async function resolveIdPrefix(tx: Tx, name: string, preferred?: string | null): Promise<string> {
  const explicit = (preferred ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const candidates = explicit ? [explicit] : candidateIdPrefixes(name);
  for (const candidate of candidates) {
    const [taken] = await tx.select({ id: schema.schools.id }).from(schema.schools)
      .where(eq(schema.schools.idPrefix, candidate)).limit(1);
    if (!taken) return candidate;
    if (explicit) throw new Error(`ID prefix "${candidate}" is already used by another school.`);
  }
  throw new Error('Could not derive a unique ID prefix for this school.');
}

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
  // OPTIONAL override for the SHORT prefix printed on every ID this school
  // issues (KC/26/0412). Left empty, it is derived from the school's name
  // (see candidateIdPrefixes) — for a school that already runs its own
  // scheme on paper, typing it here keeps new IDs consistent with the old
  // ones from day one.
  idPrefix: z
    .string()
    .trim()
    .toUpperCase()
    .max(10, 'Use 10 characters or fewer.')
    .optional()
    .transform((v) => (v === '' ? undefined : v))
    .refine((v) => v === undefined || /^[A-Z0-9]{2,10}$/.test(v), {
      message: 'Use 2–10 letters or numbers.',
    }),
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
  // OPTIONAL override. Left empty, the sign-in ID is GENERATED from the
  // principal's staff number (PRN-0001, PRN-0002, … — the existing staff
  // convention: loginId == staffNumber with '/' → '.'), checked for
  // uniqueness inside the creation transaction. The platform admin no longer
  // invents one manually unless they specifically want to.
  principalLoginId: z
    .string()
    .trim()
    .max(191, 'That sign-in ID is too long.')
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined))
    .refine((v) => v === undefined || /^[A-Za-z0-9][A-Za-z0-9._\/-]{2,190}$/.test(v), {
      message: 'Use letters, numbers, dots, hyphens or slashes.',
    }),
  // The PRINCIPAL'S OWN address — their account identity/recovery email,
  // NOT the school's institutional address (that is `email` above). Stored
  // on the users row (login + password recovery, item 12) and on the staff
  // record. Globally unique on lower(email); enforced by users_email_lc_uq.
  principalEmail: z
    .string()
    .trim()
    .toLowerCase()
    .max(320, 'That email address is too long.')
    .optional()
    .transform((v) => (v === '' ? undefined : v))
    .refine((v) => v === undefined || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), {
      message: 'Enter a valid email address, or leave it empty.',
    }),
});

export type OnboardingInput = z.input<typeof onboardingSchema>;
export type ValidatedOnboarding = z.output<typeof onboardingSchema>;

const editProfileSchema = z.object({
  name: nameSchema,
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
});

export type EditProfileInput = z.input<typeof editProfileSchema>;

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
 * The next free PRN-00NN sign-in ID inside this school, decided within the
 * creation transaction. The staff convention is loginId == staffNumber, and
 * PRN-0001 is a brand-new school's first principal; the loop only ever walks
 * past 0001 on the replacement-principal path, where the incumbent may still
 * hold the number.
 */
async function nextFreePrincipalLoginId(tx: Tx, schoolId: number): Promise<string> {
  for (let n = 1; n <= 999; n++) {
    const candidate = `PRN-${String(n).padStart(4, '0')}`;
    const [existing] = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(
        and(
          eq(schema.users.schoolId, schoolId),
          eq(schema.users.loginId, candidate),
        ),
      )
      .limit(1);
    if (!existing) return candidate;
  }
  // Practically unreachable (a school with 999 users named PRN-…), and the
  // per-school unique index still guards the insert itself.
  throw new OnboardingValidationError({
    principalLoginId: 'A sign-in ID could not be generated automatically. Enter one manually.',
  });
}

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
): Promise<{ principalUserId: number; principalName: string; loginId: string }> {
  // Generated sign-in ID when the platform admin did not override it: the
  // principal's own staff number (PRN-0001, PRN-0002 …) follows the existing
  // staff convention (loginId == staffNumber). Uniqueness is decided INSIDE
  // the transaction — a fresh school has no users yet, but the replacement-
  // principal path must not collide with the incumbent's login ID.
  const principalLoginId = input.principalLoginId ?? (await nextFreePrincipalLoginId(tx, schoolId));

  const [principalUser] = await tx
    .insert(schema.users)
    .values({
      schoolId,
      role: 'principal',
      loginId: principalLoginId,
      passwordHash,
      // The principal's own address: this is what email login (item 12) and
      // password recovery resolve — unverified until the principal confirms.
      email: input.principalEmail ?? null,
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
    // The PRINCIPAL's address, not the school's (that was the old bug):
    // a school's institutional inbox is not a person's identity.
    email: input.principalEmail ?? null,
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
      loginId: principalLoginId,
      loginIdGenerated: !input.principalLoginId,
      name: principalName,
      role: 'principal',
      email: input.principalEmail ?? null,
      temporaryPasswordIssued: true, // the value itself is never recorded
    },
  });

  return { principalUserId: Number(principalUser!.id), principalName, loginId: principalUser!.loginId };
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


/**
 * Legacy AcademicYearService parity: the academic year runs September to
 * August, so from September the session is "YYYY/(YYYY+1)" and before it
 * "(YYYY-1)/YYYY". A brand-new school gets this session plus the three
 * standard terms (First/Second/Third) with the legacy calendar dates and
 * First Term current, so the principal's dashboard and every term selector
 * work on first sign-in. Terms follow the plugin's fixed dates; schools add
 * later sessions in /portal/settings.
 */
async function seedDefaultAcademicPeriod(tx: Tx, schoolId: number): Promise<void> {
  const now = new Date();
  const year = now.getFullYear();
  const startYear = now.getMonth() >= 8 ? year : year - 1;
  const title = `${startYear}/${startYear + 1}`;
  const [session] = await tx.insert(schema.academicSessions).values({
    schoolId,
    title,
    startsOn: new Date(`${startYear}-09-01`),
    endsOn: new Date(`${startYear + 1}-07-31`),
    isCurrent: true,
  }).returning({ id: schema.academicSessions.id });
  const termDates = [
    [`${startYear}-09-01`, `${startYear}-12-20`],
    [`${startYear + 1}-01-08`, `${startYear + 1}-04-05`],
    [`${startYear + 1}-04-22`, `${startYear + 1}-07-25`],
  ] as const;
  await tx.insert(schema.terms).values(['First Term', 'Second Term', 'Third Term'].map((t, i) => ({
    schoolId,
    sessionId: Number(session!.id),
    title: t,
    position: i + 1,
    startsOn: new Date(termDates[i]![0]),
    endsOn: new Date(termDates[i]![1]),
    isCurrent: i === 0,
  })));
}

/**
 * Legacy Seeder::seed_school() parity (Core/Seeder.php): every school starts
 * with the standard Nigerian secondary structure — JSS 1–3, SS 1–3 and the
 * three senior streams — instead of an empty Classes page the principal must
 * build from nothing. This MUST run before seedStandardSubjects(): the
 * standard subject list attaches senior departmental subjects (Physics,
 * Economics, Literature, …) to a department by name lookup, so a school
 * onboarded without departments first seeds every senior elective with a
 * null department — invisible in the department subject split ever after.
 */
async function seedDefaultClassStructure(tx: Tx, schoolId: number): Promise<void> {
  await tx.insert(schema.departments).values([
    { schoolId, name: 'Science', sortOrder: 1 },
    { schoolId, name: 'Arts', sortOrder: 2 },
    { schoolId, name: 'Commercial', sortOrder: 3 },
  ]);
  await tx.insert(schema.classLevels).values([
    { schoolId, name: 'JSS 1', stage: 'junior', levelOrder: 1 },
    { schoolId, name: 'JSS 2', stage: 'junior', levelOrder: 2 },
    { schoolId, name: 'JSS 3', stage: 'junior', levelOrder: 3 },
    { schoolId, name: 'SS 1', stage: 'senior', levelOrder: 4 },
    { schoolId, name: 'SS 2', stage: 'senior', levelOrder: 5 },
    { schoolId, name: 'SS 3', stage: 'senior', levelOrder: 6 },
  ]);
}

export async function createSchoolWithPrincipal(
  actor: PlatformActor,
  rawInput: OnboardingInput,
  /** A normalizeImage()-produced bounded PNG data URL for the school's
   * crest, or undefined/null for none. Same bound enforced as the school
   * portal's own branding upload (see settings/service.ts's saveProfile). */
  logo?: string | null,
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
  if (logo != null && (!logo.startsWith('data:image/png;base64,') || logo.length > 400000)) {
    throw new OnboardingValidationError({ logo: 'Invalid normalized crest.' });
  }

  // Cryptographically secure, human-typeable. Hashed OUTSIDE the transaction —
  // Argon2 must never hold the single pooled connection hostage.
  const temporaryPassword = generateInitialPassword(12);
  const passwordHash = await hashPassword(temporaryPassword);

  const reason = `Onboard school ${input.name} (${input.code})`;

  try {
    return await asPlatformAdmin(actor.userId, reason, async (tx) => {
      const idPrefix = await resolveIdPrefix(tx, input.name, input.idPrefix);

      const [school] = await tx
        .insert(schema.schools)
        .values({
          name: input.name,
          code: input.code,
          idPrefix,
          subdomain: input.subdomain ?? null,
          email: input.email ?? null,
          phone: input.phone ?? null,
          address: input.address ?? null,
          status: input.status,
          logoUrl: logo ?? null,
        })
        .returning({
          id: schema.schools.id,
          name: schema.schools.name,
          code: schema.schools.code,
          idPrefix: schema.schools.idPrefix,
          subdomain: schema.schools.subdomain,
          status: schema.schools.status,
        });

      await seedDefaultAcademicPeriod(tx, Number(school!.id));

      // Departments and class levels BEFORE subjects — see
      // seedDefaultClassStructure's docblock for why the order matters.
      await seedDefaultClassStructure(tx, Number(school!.id));

      // Seed the standard NERDC subject offering (see subjects/service.ts). A
      // school otherwise opens its Subjects page to an empty list and types
      // thirty-odd subjects every school types identically. Safe to leave in
      // place permanently: it only ever runs for a school with no subjects.
      await seedStandardSubjects(tx, Number(school!.id), false);

      const { principalName, loginId: principalUser_loginId } = await onboardPrincipalInTx(
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
          idPrefix: school!.idPrefix,
          subdomain: school!.subdomain,
          status: school!.status,
        },
        principal: { name: principalName, loginId: principalUser_loginId },
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

      // Recovery path: if this school predates default-period seeding (or its
      // sessions were never configured), give it the standard setup now.
      const existingSessions = await tx
        .select({ id: schema.academicSessions.id })
        .from(schema.academicSessions)
        .where(eq(schema.academicSessions.schoolId, schoolId))
        .limit(1);
      if (!existingSessions.length) await seedDefaultAcademicPeriod(tx, schoolId);

      const principal = await onboardPrincipalInTx(
        tx,
        Number(school.id),
        input,
        passwordHash,
        actor.userId,
      );
      return { principalName: principal.principalName, temporaryPassword };
    });
  } catch (error) {
    throw mapDuplicate(error);
  }
}

// ── Profile editing (item 4/5 of the correction pass) ───────────────────────

/**
 * Edit an EXISTING school's safe profile fields — name, contact details,
 * address, subdomain, and crest. Deliberately narrower than onboarding:
 * `code` (the internal identifier other records key off), `id`, audit
 * history and tenant ownership are never accepted here — there is no field
 * in editProfileSchema for any of them, so there is nothing to strip.
 * `status` also stays OUT of this path on purpose: suspension/reactivation
 * keeps its own reasoned, confirmed audit trail (setSchoolStatus) rather
 * than becoming a silent side effect of a profile save.
 */
export async function updateSchoolProfile(
  actor: PlatformActor,
  schoolId: number,
  rawInput: EditProfileInput,
  /** A normalizeImage()-produced data URL to set the crest, `null` to
   * remove it, or `undefined` to leave the current crest untouched. */
  logo?: string | null,
): Promise<{ schoolId: number; name: string }> {
  assertPlatformAdmin(actor);
  const parsed = editProfileSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new OnboardingValidationError(
      Object.fromEntries(parsed.error.issues.map((issue) => [issue.path[0] ?? 'form', issue.message])),
    );
  }
  const input = parsed.data;

  // Same bound as settings/service.ts's saveProfile: the logo, if present,
  // must already be the server-normalized bounded PNG data URL — never a
  // raw upload or an arbitrary URL string.
  if (logo !== undefined && logo !== null && (!logo.startsWith('data:image/png;base64,') || logo.length > 400000)) {
    throw new OnboardingValidationError({ logo: 'Invalid normalized crest.' });
  }

  const reason = `Edit school #${schoolId} profile`;

  try {
    return await asPlatformAdmin(actor.userId, reason, async (tx) => {
      const [before] = await tx
        .select({
          name: schema.schools.name,
          email: schema.schools.email,
          phone: schema.schools.phone,
          address: schema.schools.address,
          subdomain: schema.schools.subdomain,
          logoUrl: schema.schools.logoUrl,
        })
        .from(schema.schools)
        .where(eq(schema.schools.id, schoolId))
        .limit(1);
      if (!before) throw new NotFoundError();

      const change = {
        name: input.name,
        email: input.email ?? null,
        phone: input.phone ?? null,
        address: input.address ?? null,
        subdomain: input.subdomain ?? null,
        ...(logo !== undefined ? { logoUrl: logo } : {}),
      };

      await tx.update(schema.schools).set({ ...change, updatedAt: new Date() }).where(eq(schema.schools.id, schoolId));

      await tx.insert(schema.auditLog).values({
        schoolId,
        actorUserId: actor.userId,
        actorRole: 'platform_admin',
        action: 'school.profile_updated',
        entityType: 'schools',
        entityId: schoolId,
        before,
        after: { ...change, logoUrl: logo === undefined ? before.logoUrl : logo },
      });

      return { schoolId, name: input.name };
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
  customDomain: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  logoUrl: string | null;
  createdAt: Date;
  principalName: string | null;
  principalLoginId: string | null;
  principalStatus: string | null;
  /** The principal's staff number (e.g. "PRN-0001") — shown as their
   * "Administrator Code" in the quick-view modal. */
  principalCode: string | null;
  principalEmail: string | null;
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
        customDomain: schema.schools.customDomain,
        email: schema.schools.email,
        phone: schema.schools.phone,
        address: schema.schools.address,
        logoUrl: schema.schools.logoUrl,
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
        staffNumber: schema.staff.staffNumber,
        email: schema.staff.email,
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
        principalCode: p?.staffNumber ?? null,
        principalEmail: p?.email ?? null,
      };
    });
  });
}

/** One count, one query — cheap enough to run on every /platform page for
 * the sidebar's "Schools" badge, unlike the fuller platformOverview(). */
export async function schoolsCount(actor: PlatformActor, readReason = 'Platform sidebar school count'): Promise<number> {
  assertPlatformAdmin(actor);
  return asPlatformAdmin(actor.userId, readReason, async (tx) => {
    const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.schools);
    return Number(row?.n ?? 0);
  });
}

export type PlatformOverview = {
  total: number;
  active: number;
  suspended: number;
  archived: number;
  /** Full SchoolSummary shape (not just id/name/code/status) so the
   * dashboard's "Recently created" table can open the SAME quick-view modal
   * as the schools directory, with no second fetch. */
  recent: SchoolSummary[];
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

    const recentRows = await tx
      .select({
        id: schema.schools.id,
        name: schema.schools.name,
        code: schema.schools.code,
        status: schema.schools.status,
        subdomain: schema.schools.subdomain,
        customDomain: schema.schools.customDomain,
        email: schema.schools.email,
        phone: schema.schools.phone,
        address: schema.schools.address,
        logoUrl: schema.schools.logoUrl,
        createdAt: schema.schools.createdAt,
      })
      .from(schema.schools)
      .orderBy(desc(schema.schools.createdAt))
      .limit(5);

    // Same one-query principal join as listSchools() — kept inline (rather
    // than calling listSchools() from here) because this already runs inside
    // an asPlatformAdmin transaction and the runtime pool is max:1; nesting
    // a second asPlatformAdmin call would queue behind its own transaction.
    const principals = recentRows.length
      ? await tx
          .select({
            schoolId: schema.users.schoolId,
            loginId: schema.users.loginId,
            status: schema.users.status,
            firstName: schema.staff.firstName,
            lastName: schema.staff.lastName,
            staffNumber: schema.staff.staffNumber,
            email: schema.staff.email,
          })
          .from(schema.users)
          .innerJoin(schema.staff, eq(schema.staff.userId, schema.users.id))
          .where(and(eq(schema.users.role, 'principal'), inArray(schema.users.schoolId, recentRows.map((r) => Number(r.id)))))
      : [];
    const bySchool = new Map(principals.map((p) => [Number(p.schoolId), p]));

    const recent: SchoolSummary[] = recentRows.map((r) => {
      const p = bySchool.get(Number(r.id));
      return {
        ...r,
        id: Number(r.id),
        principalName: p ? `${p.firstName} ${p.lastName}` : null,
        principalLoginId: p?.loginId ?? null,
        principalStatus: p?.status ?? null,
        principalCode: p?.staffNumber ?? null,
        principalEmail: p?.email ?? null,
      };
    });

    return {
      total: counts.reduce((sum, c) => sum + Number(c.n), 0),
      active: by('active'),
      suspended: by('suspended'),
      archived: by('archived'),
      recent,
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
        staffNumber: schema.staff.staffNumber,
        email: schema.staff.email,
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
      customDomain: school.customDomain,
      email: school.email,
      phone: school.phone,
      address: school.address,
      logoUrl: school.logoUrl,
      createdAt: school.createdAt,
      updatedAt: school.updatedAt,
      principalName: principal ? `${principal.firstName ?? ''} ${principal.lastName ?? ''}`.trim() || null : null,
      principalLoginId: principal?.loginId ?? null,
      principalStatus: principal?.status ?? null,
      principalCode: principal?.staffNumber ?? null,
      principalEmail: principal?.email ?? null,
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
  if (msg.includes('users_email_lc_uq')) {
    return new DuplicateValueError(
      'principalEmail',
      'That email address is already in use on another account.',
    );
  }
  if (msg.includes('staff_school_number_uq')) {
    return new DuplicateValueError(
      'principal',
      'This school already has an administrator on record. Contact support before adding another.',
    );
  }
  return new DuplicateValueError('form', 'A required detail is already in use. Please review and try again.');
}
