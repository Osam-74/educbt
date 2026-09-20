import { requirePlatformSession } from '@/lib/platform/session';
import { listPlatformManagers } from '@/lib/platform/managers';
import { PaIcon } from '../icons';
import { ManagersForm } from './ManagersForm';
import { ManagerRow } from './ManagerRow';

export const dynamic = 'force-dynamic';

/**
 * PLATFORM MANAGERS: create, suspend and reactivate additional platform
 * administrators. The directory reads through the same audited elevation
 * as every other cross-tenant screen; the create form hands the temporary
 * password back exactly once (see ManagersForm).
 *
 * Guardrails live in the service, not here: you cannot suspend yourself,
 * and the last active manager cannot be suspended.
 */
export default async function ManagersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const params = await searchParams;
  const actor = await requirePlatformSession();
  const managers = await listPlatformManagers(actor, 'View platform manager directory');

  return (
    <div id="platform-managers-view">
      <div className="pa-page-head" style={{ marginBottom: 20 }}>
        <div>
          <h1>Managers</h1>
          <p>Platform administrators with full access to this console.</p>
        </div>
      </div>

      {params.error ? (
        <div className="pa-alert pa-alert--error" style={{ marginBottom: 16 }}>
          <PaIcon name="alert" width={15} height={15} />{params.error}
        </div>
      ) : null}
      {params.ok ? (
        <div className="pa-alert pa-alert--ok" style={{ marginBottom: 16 }}>
          <PaIcon name="checkCircle" width={15} height={15} />{params.ok}
        </div>
      ) : null}

      <details className="pa-details">
        <summary><span className="pa-details-title">Add a manager</span></summary>
        <div className="pa-details-body">
          <ManagersForm />
        </div>
      </details>

      <div className="pa-glass pa-panel">
        <div className="pa-panel-head" style={{ padding: '14px 18px' }}>
          <span style={{ fontWeight: 700, fontSize: 13 }}>
            Managers on the platform
            <span className="pa-count-badge" style={{ marginLeft: 8 }}>{managers.length}</span>
          </span>
        </div>
        <div className="pa-table-wrap">
          <table className="pa-table" id="managers-table">
            <thead>
              <tr>
                <th>Sign-in ID</th>
                <th>Email</th>
                <th>Two-factor</th>
                <th>Status</th>
                <th>Created</th>
                <th className="pa-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {managers.map((m) => (
                <ManagerRow key={m.id} manager={m} isSelf={m.id === actor.userId} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
