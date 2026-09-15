import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/**
 * The account-profile page moved into the consolidated Settings → Account
 * screen (/platform/account, correction-pass item 14). This route now only
 * forwards — old links and bookmarks keep working.
 */
export default function ProfilePage() {
  redirect('/platform/account');
}
