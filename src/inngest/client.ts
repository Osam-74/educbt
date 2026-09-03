/**
 * Inngest client — the background-job provider.
 *
 * The signing key is read from INNGEST_SIGNING_KEY (server-only secret) by
 * the SDK; the route (src/app/api/inngest/route.ts) refuses to serve
 * production traffic without it, so an unsigned forge cannot reach the jobs.
 *
 * In development, INNGEST_DEV=1 points the SDK at the local dev server
 * (npx inngest-cli dev, http://127.0.0.1:8288) and no credentials are needed.
 */

import { Inngest } from 'inngest';

export const inngest = new Inngest({
  id: 'educbt',
  name: 'EduCBT',
});
