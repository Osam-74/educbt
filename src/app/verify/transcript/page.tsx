import { eq } from 'drizzle-orm';
import { db, schema } from '@/db';
import { verificationAvailable, verifyCode } from '@/lib/promotion/transcript';

export const dynamic = 'force-dynamic';

/**
 * PUBLIC transcript verification (no sign-in).
 *
 * The printed document carries serial + verification code, where the code is
 * HMAC-SHA256(server secret, serial) — never stored, never derivable from the
 * serial alone, so a serial cannot be enumerated and a code cannot be forged.
 * The page reveals nothing until BOTH match: no school name, no student
 * identity, no grades. It answers one question only — is this issued document
 * genuine and still standing?
 */
export default async function VerifyTranscriptPage({
  searchParams,
}: {
  searchParams: Promise<{ serial?: string; code?: string }>;
}) {
  const query = await searchParams;
  const serial = (query.serial ?? '').trim();
  const code = (query.code ?? '').trim();

  let result: { state: 'valid' | 'revoked' | 'bad_code' | 'not_found' | 'unconfigured'; issuedAt?: Date; status?: string } | null = null;

  if (serial && code) {
    if (!verificationAvailable()) {
      result = { state: 'unconfigured' };
    } else if (!verifyCode(serial, code)) {
      // A wrong code gets the same answer as an unknown serial: the serial
      // space is unguessable, but probing it should learn nothing either way.
      result = { state: 'not_found' };
    } else {
      // Reads by serial OUTSIDE RLS on purpose: the serial + code are the
      // capability (the same model as the public photo token route), and only
      // the transcript row itself is read — no joins into school or student data.
      const [row] = await db.select({
        status: schema.transcripts.status, issuedAt: schema.transcripts.issuedAt,
      }).from(schema.transcripts).where(eq(schema.transcripts.serial, serial));
      result = row
        ? { state: row.status === 'revoked' ? 'revoked' : 'valid', issuedAt: row.issuedAt, status: row.status }
        : { state: 'not_found' };
    }
  }

  return (
    <main style={{ maxWidth: 560, margin: '48px auto', padding: '0 16px', fontFamily: 'system-ui, sans-serif' }}>
      <h1>Transcript verification</h1>
      <p className="muted">Enter the serial number and verification code printed on the transcript.</p>

      <form method="get" action="/verify/transcript" style={{ display: 'grid', gap: 8, margin: '16px 0' }}>
        <label htmlFor="serial">Serial number</label>
        <input id="serial" name="serial" defaultValue={serial} placeholder="SCH/TR/2026/0001" required maxLength={60} />
        <label htmlFor="code">Verification code</label>
        <input id="code" name="code" defaultValue={code} placeholder="10-character code" required maxLength={10} pattern="[0-9a-fA-F]{10}" />
        <button type="submit">Verify</button>
      </form>

      {result?.state === 'valid' ? (
        <p className="ok" role="status">
          <strong>Genuine.</strong> This transcript ({result.status}) was issued on {result.issuedAt!.toISOString().slice(0, 10)} and is still standing.
        </p>
      ) : null}
      {result?.state === 'revoked' ? (
        <p className="alert" role="alert">
          <strong>Revoked.</strong> This serial was issued on {result.issuedAt!.toISOString().slice(0, 10)} but has since been revoked by the school. Treat any copy as invalid.
        </p>
      ) : null}
      {result?.state === 'not_found' ? (
        <p className="alert" role="alert">
          <strong>Not verified.</strong> No standing transcript matches that serial and code. Check both against the printed document.
        </p>
      ) : null}
      {result?.state === 'unconfigured' ? (
        <p className="alert" role="alert">
          <strong>Unavailable.</strong> This server has not been configured for transcript verification (TRANSCRIPT_VERIFY_SECRET). Contact the school to verify the document against its records.
        </p>
      ) : null}
    </main>
  );
}
