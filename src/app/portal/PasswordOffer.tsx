import Link from 'next/link';

/**
 * Shown once to a person whose school moved over from the WordPress plugin. Their old password still works;
 * this only offers a fresh one. "Keep my password" is final and never shown again.
 */
export default function PasswordOffer({ keepPassword }: { keepPassword: () => Promise<void> }) {
  return (
    <div className="ps-offer" role="region" aria-label="Optional password update">
      <p className="ps-offer-text">
        <strong>Your school has moved to the new EduCBT.</strong> You can keep signing in with the password you already use.
        If you would like a fresh one, you can set it now. This is optional.
      </p>
      <div className="ps-offer-actions">
        <Link className="sa-btn" href="/portal/account/password">Set a new password</Link>
        <form action={keepPassword}><button className="sa-btn sa-btn--ghost" type="submit">Keep my password</button></form>
      </div>
    </div>
  );
}
