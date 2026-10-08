import type { HelpArticle } from '../types';

/**
 * Account & Security. Sources verified against the running code:
 *   sign-in           src/app/sign-in/page.tsx, src/lib/auth/credentials.ts
 *   forgot / reset    src/app/forgot-password, src/app/reset-password, src/lib/auth/recovery.ts
 *   change password   src/app/(standalone)/portal/account/password, src/lib/auth/change-password.ts
 *   recovery email    src/app/portal/account/profile, src/lib/auth/recovery-email.ts
 *   two-factor        src/app/portal/account/security, src/app/sign-in/two-step, src/lib/auth/recovery-codes.ts
 *   lockout           src/lib/auth/throttle.ts (lockoutUntil)
 */
export const accountSecurity: HelpArticle[] = [
  {
    slug: 'signing-in',
    category: 'account-security',
    title: 'Signing In',
    description: 'How to reach your school’s sign-in page and what to enter.',
    keywords: ['login', 'log in', 'sign in', 'sign-in id', 'username', 'school address', 'portal address', 'subdomain'],
    audience: ['all'],
    where: 'Sign-in page',
    popular: true,
    icon: 'key',
    blocks: [
      { type: 'p', text: 'Every school signs in at its own web address, and the address tells EduCBT which school you belong to. Use the address your school gave you; it looks like your school’s name followed by the EduCBT domain.' },
      { type: 'steps', title: 'Sign in', items: [
        'Open your school’s EduCBT address in your browser.',
        'Enter your **sign-in ID** in the first box. Staff and students each have an ID issued by the school; for a student it is the student ID.',
        'Enter your **password**. Use the eye icon in the password box if you want to check what you typed.',
        'Select **Sign in**.',
        'If two-factor security is switched on for your account, you will be asked for a 6-digit code next. See *Two-Factor Authentication*.',
      ] },
      { type: 'note', text: 'If you type a wrong address that is not linked to an active school, EduCBT shows “No school at this address”. Check the address with your school office.' },
      { type: 'note', text: 'The first time you sign in with a password the school gave you, EduCBT may ask you to set your own password before you can continue.' },
      { type: 'h', text: 'If you keep getting it wrong' },
      { type: 'p', text: 'After five wrong passwords in a row the account is paused for a short time, and the pause grows with each further failure (1 minute, 2, 4 and so on, up to 1 hour). Wait for the time to pass, then try again, or use *Forgot Password*.' },
    ],
    related: ['forgot-password', 'changing-your-password', 'two-factor-authentication', 'sign-in-problems'],
  },
  {
    slug: 'changing-your-password',
    category: 'account-security',
    title: 'Changing Your Password',
    description: 'Change your own password while you are signed in.',
    keywords: ['password', 'change password', 'new password', 'update password', 'account password'],
    audience: ['all'],
    where: 'Sidebar › your name',
    popular: true,
    icon: 'key',
    blocks: [
      { type: 'steps', title: 'Change your password', items: [
        'Select your **name** at the bottom of the portal sidebar (on a phone, open the menu first). This opens **Change your password**.',
        'Enter your **Current password**.',
        'Enter a **New password** and type it again in **Confirm new password**.',
        'Select **Save password**.',
      ] },
      { type: 'list', items: [
        'The new password must be at least **8 characters** long.',
        'It must be **different from your current password**.',
      ] },
      { type: 'note', text: 'If the school gave you a temporary password, EduCBT shows **Set your password** instead and asks you to choose a new one before you can use the portal. This is normal.' },
      { type: 'warning', text: 'Never share your password. Staff and the school office will not ask for it. If you suspect someone else knows it, change it straight away.' },
    ],
    related: ['forgot-password', 'two-factor-authentication', 'recovery-email', 'password-problems'],
  },
  {
    slug: 'forgot-password',
    category: 'account-security',
    title: 'Forgot Password',
    description: 'What to do when you cannot remember your password.',
    keywords: ['forgot password', 'reset password', 'password recovery', 'reset link', 'cannot remember password', 'lost password'],
    audience: ['all'],
    where: 'Sign-in page › Forgot password?',
    popular: true,
    icon: 'key',
    blocks: [
      { type: 'p', text: 'There are two ways back in, depending on whether your account has a recovery email on file.' },
      { type: 'h', text: 'If your account has a recovery email' },
      { type: 'steps', items: [
        'On the sign-in page, select **Forgot password?**.',
        'Enter your **sign-in ID or email** and select **Send reset link**.',
        'EduCBT always shows the same message whether or not an account was found: “If an eligible account exists, password-reset instructions have been sent.” This is deliberate, so nobody can use the page to find out who has an account.',
        'Open the email, follow the link and choose a new password.',
      ] },
      { type: 'list', items: [
        'The reset link works **once** and **expires after 30 minutes**.',
        'If it has expired or was already used, request a new one.',
      ] },
      { type: 'warning', text: 'Reset emails depend on your school’s email delivery being switched on. If nothing arrives (check spam too), do not keep requesting links: ask your school office to issue a new password.' },
      { type: 'h', text: 'If your account has no recovery email' },
      { type: 'p', text: 'Most students do not have a recovery email. In that case the **school office can issue a new password in person**. Ask them; they will give you a temporary password that you change when you next sign in.' },
    ],
    related: ['recovery-email', 'changing-your-password', 'password-problems', 'sign-in-problems'],
  },
  {
    slug: 'recovery-email',
    category: 'account-security',
    title: 'Recovery Email',
    description: 'Add or change the email address used to send password-reset links.',
    keywords: ['recovery email', 'email address', 'profile', 'reset email', 'account email', 'unverified'],
    audience: ['all'],
    where: 'Your account page (/portal/account/profile)',
    icon: 'mail',
    blocks: [
      { type: 'p', text: 'The recovery email is where EduCBT sends a password-reset link if you forget your password. It is optional.' },
      { type: 'steps', title: 'Add or change it', items: [
        'Open the **Your account** page at `/portal/account/profile` on your school’s EduCBT address (add it after the web address you normally use). There is no menu item for it yet.',
        'Under **Recovery email**, type your **Email address**.',
        'Enter your **Current password** to confirm it is you.',
        'Select **Save email** (or **Change email** if one is already saved).',
      ] },
      { type: 'note', text: 'An address you have not confirmed is marked **(unverified)** next to the field. Most students have no recovery email; the school office issues them a new password in person instead.' },
      { type: 'warning', text: 'Reset emails are only delivered once your school’s email delivery is switched on, so do not rely on this alone. Clearing the field removes the address; after that only the school office can recover your account.' },
    ],
    related: ['forgot-password', 'changing-your-password', 'managing-your-account'],
  },
  {
    slug: 'two-factor-authentication',
    category: 'account-security',
    title: 'Two-Factor Authentication',
    description: 'Protect your account with a code from an authenticator app, and what to do if you lose it.',
    keywords: ['2fa', 'two factor', 'two-factor', 'two step', 'authenticator', 'totp', 'recovery codes', 'google authenticator', 'authy', '1password', 'qr code'],
    audience: ['principal', 'vice_principal', 'exam_officer', 'teacher'],
    where: 'Change your password › Two-factor security',
    popular: true,
    icon: 'shield',
    blocks: [
      { type: 'p', text: 'Two-factor security means a password alone is not enough to reach your account: you also need a 6-digit code from an authenticator app on your phone (for example Google Authenticator, Authy or 1Password). It is optional and is switched on by the account holder. It is available to the Principal, Vice Principal, Examination Officer and Teachers.' },
      { type: 'steps', title: 'Turn it on', items: [
        'Open **Change your password** (select your name in the sidebar) and select **Two-factor security (authenticator app)** at the bottom.',
        'Select **Start setup**.',
        'In your authenticator app choose **Add account** and scan the code on screen. If you cannot scan, open **Can’t scan? Enter the key manually** and type the key. If the app asks, choose type *Time-based*, *6 digits*, *30 seconds*.',
        'Enter the six-digit **Current code** the app is showing and select **Confirm and turn on**.',
        'Save your **recovery codes** (see below).',
      ] },
      { type: 'h', text: 'Recovery codes' },
      { type: 'p', text: 'When you turn two-factor on, EduCBT shows a set of **8 one-time recovery codes**. This is the only time they are shown.' },
      { type: 'list', items: [
        'Each code works **once**, in place of an authenticator code at sign-in.',
        'Using one also asks you to **set a new password**.',
        'Keep them somewhere safe, such as paper, rather than only on your phone.',
        'The page tells you how many unused codes remain. To make a fresh set, open **Regenerate recovery codes**, enter a code from your authenticator and select **Generate new codes**. The old codes stop working.',
      ] },
      { type: 'h', text: 'Signing in with two-factor' },
      { type: 'steps', items: [
        'Sign in with your ID and password as usual.',
        'On **Two-step verification**, enter the 6-digit code from your authenticator app and select **Verify**.',
        'No phone? Open **Lost your authenticator? Use a recovery code**, enter a code like XXXXX-XXXXX and select **Use recovery code**.',
      ] },
      { type: 'h', text: 'Turning it off' },
      { type: 'p', text: 'Open **Two-factor security** (see above), enter a code from your authenticator and select **Turn off two-factor**. You need a valid code to do this.' },
      { type: 'warning', text: 'If you have lost your authenticator and have no recovery codes left, only the school office can get you back in. They reset your account the same way they issue a new password.' },
    ],
    related: ['signing-in', 'two-factor-problems', 'changing-your-password', 'managing-your-account'],
  },
  {
    slug: 'managing-your-account',
    category: 'account-security',
    title: 'Managing Your Account',
    description: 'Where to find your account settings and what you can change yourself.',
    keywords: ['account', 'profile', 'settings', 'sign out', 'log out', 'your account'],
    audience: ['all'],
    where: 'Sidebar › your name',
    icon: 'user',
    blocks: [
      { type: 'p', text: 'The things that belong to you live in three places. Your name at the bottom of the portal sidebar opens **Change your password**.' },
      { type: 'table', head: ['What', 'How to reach it', 'Who can use it'], rows: [
        ['Change your password', 'Select your name in the sidebar', 'Everyone who signs in'],
        ['Two-factor security', 'Link at the bottom of Change your password', 'Principal, Vice Principal, Examination Officer, Teacher'],
        ['Recovery email', 'The Your account page, `/portal/account/profile`', 'Anyone signed in (most students have none)'],
      ] },
      { type: 'p', text: 'To leave the portal, use the **Sign out** button in the sidebar. Always sign out on a shared or school computer.' },
      { type: 'note', text: 'Your name, class and ID are managed by the school office. If something about you is wrong, ask them to correct it.' },
    ],
    related: ['changing-your-password', 'recovery-email', 'two-factor-authentication', 'signing-in'],
  },
];
