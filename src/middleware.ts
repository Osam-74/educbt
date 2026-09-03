/**
 * Request gate.
 *
 * Three jobs, in order:
 *   1. require a session cookie for anything under /portal
 *   2. set security headers on every response
 *
 * What deliberately does NOT happen here: tenant resolution and the forced
 * password-change redirect. Edge middleware has no database, so it cannot
 * verify anything about the session — it only checks cookie PRESENCE and
 * bounces anonymous visitors early. Validity (expiry, suspension, lockout,
 * must-change-password) is decided per request on the server from the live
 * rows (src/lib/auth/session-store.ts, src/lib/session.ts), where a redirect
 * cannot be skipped by typing a URL.
 */

import { NextResponse, type NextRequest } from 'next/server';

const PUBLIC_PATHS = ['/sign-in', '/trial', '/_next', '/favicon.ico'];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Presence only — the session's VALIDITY (expiry, suspension, lockout) is
  // decided per request on the server from the live row, never here. Edge
  // middleware has no database; a cookie check is the only safe thing to do.
  const sessionCookie = req.cookies.get('educbt.session');

  if (pathname.startsWith('/portal') && !sessionCookie) {
    const url = req.nextUrl.clone();
    url.pathname = '/sign-in';
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }

  const res = NextResponse.next();

  // Security headers. The exam room in particular must not be embeddable —
  // an iframe wrapper is how a paper gets scraped or a student gets phished.
  res.headers.set('X-Frame-Options', 'DENY');
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('Referrer-Policy', 'same-origin');
  res.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  return res;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
