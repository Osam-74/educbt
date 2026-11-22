/**
 * Document-template assignment.
 *
 * SECURITY MODEL (mirrors platform/branding.ts):
 *   - READ: school_document_templates is tenant-readable (a school resolves
 *     its own templates inside forSchool()); platform_settings is public-read.
 *   - WRITE: platform admin only — RLS enforces it (see rls.sql additions) AND
 *     every function here re-checks the actor. A principal can never change
 *     their school's templates, even with a hand-crafted request.
 *   - Every change writes an audit_log row with before/after.
 */
import { eq, sql } from 'drizzle-orm';
import { db, schema, asPlatformAdmin, type Tx } from '@/db';
import type { PlatformActor } from '@/lib/platform/session';
import { assertPlatformAdmin } from '@/lib/platform/schools';
import {
  DOC_KINDS, DEFAULT_TEMPLATE, isTemplateKey, resolveTemplate,
  type DocKind, type TemplateKey,
} from './registry';

export class TemplateError extends Error {}

export type ResolvedTemplates = Record<DocKind, TemplateKey>;
type AssignmentInput = Partial<Record<DocKind, string | null>>; // null/'' = inherit platform default

/** Effective templates for one school. Call inside forSchool(): `tx` is tenant-scoped. */
export async function getDocumentTemplates(
  tx: Pick<Tx, 'select'>,
  schoolId: number,
): Promise<ResolvedTemplates> {
  const [own] = await tx.select().from(schema.schoolDocumentTemplates)
    .where(eq(schema.schoolDocumentTemplates.schoolId, schoolId)).limit(1);
  const [platform] = await tx.select().from(schema.platformSettings)
    .where(eq(schema.platformSettings.id, 1)).limit(1);
  return {
    report: resolveTemplate(own?.reportTemplate, platform?.defaultReportTemplate),
    transcript: resolveTemplate(own?.transcriptTemplate, platform?.defaultTranscriptTemplate),
    broadsheet: resolveTemplate(own?.broadsheetTemplate, platform?.defaultBroadsheetTemplate),
  };
}

function clean(input: AssignmentInput, allowInherit: boolean) {
  const out: Partial<Record<DocKind, string | null>> = {};
  for (const kind of DOC_KINDS) {
    if (!(kind in input)) continue;
    const v = input[kind];
    if (v === null || v === '' || v === undefined) {
      if (!allowInherit) throw new TemplateError('Choose a template for every document type.');
      out[kind] = null;
    } else if (isTemplateKey(v)) out[kind] = v;
    else throw new TemplateError(`Unknown template "${v}".`);
  }
  return out;
}

/** Set (or clear → inherit) a school's templates. Platform admin only. */
export async function setSchoolTemplates(actor: PlatformActor, schoolId: number, input: AssignmentInput) {
  assertPlatformAdmin(actor);
  const change = clean(input, true);
  await asPlatformAdmin(actor.userId, `Set document templates for school #${schoolId}`, async (tx) => {
    const [school] = await tx.select({ id: schema.schools.id }).from(schema.schools)
      .where(eq(schema.schools.id, schoolId)).limit(1);
    if (!school) throw new TemplateError('School not found.');
    const [before] = await tx.select().from(schema.schoolDocumentTemplates)
      .where(eq(schema.schoolDocumentTemplates.schoolId, schoolId)).limit(1);
    const values = {
      schoolId,
      reportTemplate: 'report' in change ? change.report : (before?.reportTemplate ?? null),
      transcriptTemplate: 'transcript' in change ? change.transcript : (before?.transcriptTemplate ?? null),
      broadsheetTemplate: 'broadsheet' in change ? change.broadsheet : (before?.broadsheetTemplate ?? null),
      updatedAt: new Date(),
    };
    await tx.insert(schema.schoolDocumentTemplates).values(values)
      .onConflictDoUpdate({ target: schema.schoolDocumentTemplates.schoolId, set: values });
    await tx.insert(schema.auditLog).values({
      schoolId, actorUserId: actor.userId, actorRole: 'platform_admin',
      action: 'school.templates_changed', entityType: 'school_document_templates', entityId: schoolId,
      before: before ?? null, after: values,
    });
  });
}

/** Platform-wide default used by every school without its own assignment. */
export async function setPlatformDefaultTemplates(actor: PlatformActor, input: AssignmentInput) {
  assertPlatformAdmin(actor);
  const change = clean(input, false);
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.platform_admin', 'on', true)`);
    const [before] = await tx.select().from(schema.platformSettings)
      .where(eq(schema.platformSettings.id, 1)).limit(1);
    const set = {
      ...(change.report ? { defaultReportTemplate: change.report } : {}),
      ...(change.transcript ? { defaultTranscriptTemplate: change.transcript } : {}),
      ...(change.broadsheet ? { defaultBroadsheetTemplate: change.broadsheet } : {}),
      updatedAt: new Date(),
    };
    await tx.insert(schema.platformSettings).values({ id: 1, ...set })
      .onConflictDoUpdate({ target: schema.platformSettings.id, set });
    await tx.insert(schema.auditLog).values({
      schoolId: null, actorUserId: actor.userId, actorRole: 'platform_admin',
      action: 'platform.default_templates_changed', entityType: 'platform_settings', entityId: 1,
      before: before ? {
        report: before.defaultReportTemplate, transcript: before.defaultTranscriptTemplate,
        broadsheet: before.defaultBroadsheetTemplate,
      } : null,
      after: change,
    });
  });
}

export { DEFAULT_TEMPLATE };
