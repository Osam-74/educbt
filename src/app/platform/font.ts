import { Montserrat } from 'next/font/google';

/**
 * Platform Admin's own typeface, loaded via next/font so there is no extra
 * network dependency beyond what Next already self-hosts. Scoped to the
 * Platform Admin shell ONLY (imported by src/app/platform/layout.tsx and the
 * two standalone account pages that render PlatformShell directly) — the
 * school portal and root app keep their existing fonts untouched.
 *
 * Trebuchet MS is the practical fallback (a real font, not a webfont) when
 * Montserrat hasn't loaded yet; see the --font-montserrat stack in
 * platform-shell.css.
 */
export const montserrat = Montserrat({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-montserrat',
  display: 'swap',
});
