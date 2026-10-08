import { currentActor } from '@/lib/session';
import { isHelpRole } from './roles';
import type { HelpRole } from './types';

/**
 * The signed-in visitor's role, for choosing which guides to feature first.
 * This is about RELEVANCE, not secrecy: the guides only describe screens the
 * reader must be signed in and authorised to open, and expose no data. Real
 * access control stays on those pages. A signed-out visitor (for example
 * someone who cannot sign in) gets everything, each guide labelled "For: ...".
 */
export async function viewerRole(requested?: string | null): Promise<{ role: HelpRole | null; own: HelpRole | null }> {
  const actor = await currentActor().catch(() => null);
  const own = actor && isHelpRole(actor.role) ? (actor.role as HelpRole) : null;
  // ?role=all is the explicit "show me everything" choice, so it must not fall back to the viewer's own role.
  if (requested === 'all') return { role: null, own };
  const chosen = isHelpRole(requested ?? null) ? (requested as HelpRole) : null;
  return { role: chosen ?? own, own };
}
