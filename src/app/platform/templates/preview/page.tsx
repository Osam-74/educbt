import { notFound } from 'next/navigation';
import { requirePlatformSession } from '@/lib/platform/session';
import { DOC_KINDS, isTemplateKey, templateClass, TEMPLATES, DOC_KIND_LABEL, type DocKind } from '@/lib/templates/registry';
import { DemoReport, DemoTranscript, DemoBroadsheet } from './demo';
import '../../../print.css';
import '../../../templates.css';

export const dynamic = 'force-dynamic';

/**
 * A SAMPLE of one document in one design, for the platform administrator choosing a template. It draws fixed made-up data
 * (a fictional school and student) and reads nothing from the database, so no real student can ever appear here. It is
 * only reachable with a platform session, and anything that is not a known document type and a known design is a 404.
 */
export default async function TemplatePreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; template?: string }>;
}) {
  await requirePlatformSession();
  const { kind, template } = await searchParams;
  if (!DOC_KINDS.includes(kind as DocKind) || !isTemplateKey(template)) notFound();
  const k = kind as DocKind;
  const cls = templateClass(template);
  const label = TEMPLATES.find((t) => t.key === template)!.label;

  return (
    <div id="template-preview" data-kind={k} data-template={template}>
      <p className="pa-field-hint" style={{ margin: '0 0 10px' }}>
        Sample only: {DOC_KIND_LABEL[k]} in the {label} design, with made-up names and marks.
      </p>
      {k === 'report' ? <DemoReport cls={cls} /> : k === 'transcript' ? <DemoTranscript cls={cls} /> : <DemoBroadsheet cls={cls} />}
    </div>
  );
}
