import { requirePlatformSession } from '@/lib/platform/session';
import { viewTemplateAssignments } from '@/lib/templates/service';
import { TemplateSelectors } from './TemplateSelectors';
import { savePlatformDefaultsAction } from './actions';
import { PaIcon } from '../icons';

export const dynamic = 'force-dynamic';

/**
 * PLATFORM DEFAULT DOCUMENT TEMPLATES: the design every school prints with unless the platform administrator gave that school
 * its own. Platform administrators only; a school never sees this page or the names of the designs.
 */
export default async function PlatformTemplatesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; done?: string }>;
}) {
  const params = await searchParams;
  const actor = await requirePlatformSession();
  const { defaults } = await viewTemplateAssignments(actor, null);

  return (
    <div id="platform-templates-view" style={{ maxWidth: 760, margin: '0 auto' }}>
      <div className="pa-page-head" style={{ marginBottom: 20 }}>
        <div>
          <h1>Document templates</h1>
          <p>
            The default look of report cards, transcripts and broadsheets. A school with no design of its own prints with these.
            Classic is the original sheet. To give one school a different design, open that school and choose Document templates.
          </p>
        </div>
      </div>

      {params.error ? (
        <div className="pa-alert pa-alert--error" style={{ marginBottom: 16 }}>
          <PaIcon name="alert" width={15} height={15} />{params.error}
        </div>
      ) : null}
      {params.done ? (
        <div className="pa-alert pa-alert--ok" style={{ marginBottom: 16 }}>
          <PaIcon name="checkCircle" width={15} height={15} />Saved. Schools without their own design now print with these.
        </div>
      ) : null}

      <form action={savePlatformDefaultsAction}>
        <TemplateSelectors current={defaults} />
        <div style={{ marginTop: 16 }}>
          <button type="submit" className="pa-btn pa-btn--primary" id="save-default-templates-btn">Save platform defaults</button>
        </div>
      </form>
    </div>
  );
}
