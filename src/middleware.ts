/**
 * Request gate.
 *
 * Three jobs, in order:
 *   1. resolve the school from the hostname
 *   2. require a session for anything under /portal
 *   3. force a password change before anything else can be reached
 *
 * (3) is here rather than in a page redirect because a redirect can be skipped
 * by typing a different URL. Middleware sees every request.
 */

import { NextResponse, type NextRequest } from 'next/server';

const PUBLIC_PATHS = ['/sign-in', '/api/auth', '/trial', '/_next', '/favicon.ico'];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  const sessionCookie =
    req.cookies.get('authjs.session-token') ??
    req.cookies.get('__Secure-authjs.session-token');

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
