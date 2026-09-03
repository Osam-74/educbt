/**
 * Inngest webhook route — the ONLY entry point the provider can reach.
 *
 * Security model (README § Background jobs):
 *   - serve() (inngest/next) cryptographically verifies the x-inngest-signature
 *     header on every invoke/registration request: HMAC-SHA256 over the body
 *     with INNGEST_SIGNING_KEY, plus a timestamp window. Unsigned or
 *     incorrectly signed calls are rejected — this is never an open
 *     "trigger maintenance now" endpoint.
 *   - Fail-closed gate: in production WITHOUT INNGEST_SIGNING_KEY the mutating
 *     verbs (POST invoke, PUT registration) return 503. The SDK would
 *     otherwise skip signature validation, and an unauthenticated route that
 *     mutates academic state is worse than no route.
 *   - Development (INNGEST_DEV=1) needs no credentials: the local dev server
 *     signs its own traffic.
 *
 * Production: deploy the app publicly reachable on /api/inngest (Vercel does
 * this automatically), then set INNGEST_SIGNING_KEY from the Inngest dashboard
 * (Environment → Keys). No Vercel config additions are required for this
 * route; schedules are managed in the Inngest dashboard.
 */

import { serve } from 'inngest/next';
import type { NextRequest } from 'next/server';
import { inngest } from '@/inngest/client';
import { jobs } from '@/inngest/functions';

export const dynamic = 'force-dynamic';

const handler = serve({ client: inngest, functions: jobs });

const signingKeyMissing = () =>
  process.env.NODE_ENV === 'production' && !process.env.INNGEST_SIGNING_KEY;

const guarded =
  (verb: typeof handler.POST) =>
  async (req: NextRequest, res: unknown): Promise<Response> => {
    if (signingKeyMissing()) {
      return new Response('INNGEST_SIGNING_KEY is not configured', { status: 503 });
    }
    return verb(req, res);
  };

// GET is the unauthenticated liveness/registration probe the provider polls —
// it exposes only the framework name and function registry, no data.
export const GET = handler.GET;
export const POST = guarded(handler.POST);
export const PUT = guarded(handler.PUT);
