import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePlatformSession } from '@/lib/platform/session';
import { viewTemplateAssignments } from '@/lib/templates/service';
import { DOC_KINDS, DOC_KIND_LABEL, TEMPLATES, resolveTemplate } from '@/lib/templates/registry';
import { TemplateSelectors } from '../../../templates/TemplateSelectors';
import { saveSchoolTemplatesAction } from '../../../templates/actions';
import { PaIcon } from '../../../icons';

export const dynamic = 'force-dynamic';

const labelOf = (key: string) => TEMPLATES.find((t) => t.key === key)?.label ?? key;

/**
 * ONE SCHOOL'S DOCUMENT TEMPLATES: platform administrators only. "Inherit the platform default" clears the school's own choice.
 * The school's own screens never show this, nor the names of the designs; it simply prints with what is assigned here.
 */
export default async function SchoolTemplatesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; done?: string }>;
}) {
  const { id } = await params;
  const flash = await searchParams;
  const actor = await requirePlatformSession();
  const schoolId = Number(id);
  if (!Number.isInteger(schoolId) || schoolId <= 0) notFound();

  const { defaults, own, school } = await viewTemplateAssignments(actor, schoolId);
  if (!school || !own) notFound();

  const printing = DOC_KINDS.map((k) => `${DOC_KIND_LABEL[k]}: ${labelOf(resolveTemplate(own[k], defaults[k]))}`).join(' · ');

  return (
    <div id="school-templates-view" style={{ maxWidth: 760, margin: '0 auto' }}>
      <p style={{ marginBottom: 12 }}>
        <Link href={`/platform/schools/${school.id}`} style={{ fontSize: 13, color: 'var(--pa-stone-500)', textDecoration: 'none' }}>
          &larr; {school.name}
        </Link>
      </p>
      <div className="pa-page-head" style={{ marginBottom: 20 }}>
        <div>
          <h1>Document templates</h1>
          <p>How {school.name} prints its report cards, transcripts and broadsheets. It applies automatically; the school has no setting for it.</p>
        </div>
      </div>

      {flash.error ? (
        <div className="pa-alert pa-alert--error" style={{ marginBottom: 16 }}>
          <PaIcon name="alert" width={15} height={15} />{flash.error}
        </div>
      ) : null}
      {flash.done ? (
        <div className="pa-alert pa-alert--ok" style={{ marginBottom: 16 }}>
          <PaIcon name="checkCircle" width={15} height={15} />Saved.
        </div>
      ) : null}

      <p id="templates-printing-now" className="pa-card pa-card-pad" style={{ marginBottom: 16 }}>
        <strong>Printing now</strong><br />{printing}
      </p>

      <form action={saveSchoolTemplatesAction}>
        <input type="hidden" name="schoolId" value={school.id} />
        <TemplateSelectors current={own} inheritLabel="Inherit the platform default" />
        <div style={{ marginTop: 16 }}>
          <button type="submit" className="pa-btn pa-btn--primary" id="save-school-templates-btn">Save this school&rsquo;s templates</button>
        </div>
      </form>
    </div>
  );
}
