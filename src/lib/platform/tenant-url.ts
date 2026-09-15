/**
 * Builds the real, calculated tenant address for a school — never a
 * hardcoded/obsolete hostname. `PLATFORM_DOMAIN` is the same env var the
 * sign-in flow and tenant resolver already use (src/lib/tenant.ts,
 * src/app/sign-in/page.tsx): schools resolve as `<subdomain>.PLATFORM_DOMAIN`.
 */
export function tenantUrl(subdomain: string | null | undefined, platformDomain: string | null): string | null {
  if (!subdomain || !platformDomain) return null;
  return `https://${subdomain}.${platformDomain}`;
}

/** The school's best-known public address: a verified custom domain if it has
 * one, otherwise its platform subdomain. */
export function bestSchoolUrl(
  school: { subdomain: string | null; customDomain?: string | null },
  platformDomain: string | null,
): string | null {
  if (school.customDomain) return `https://${school.customDomain}`;
  return tenantUrl(school.subdomain, platformDomain);
}
