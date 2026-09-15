'use client';

/**
 * The Platform Admin shell: fixed/collapsible desktop sidebar, mobile slide-out
 * drawer, sticky header, and a confirm-before-sign-out modal.
 *
 * Visual reference: the approved educbt-platform prototype (forest green
 * #0e261a shell, emerald/lime accents). This component owns ONLY presentation
 * and navigation state (collapse, mobile-open, profile menu, sign-out
 * confirmation) — the actual sign-out is the same server action the old
 * layout used (`endSession`, wrapped in a <form>), so session revocation is
 * unchanged. Follows the same conventions as the school portal's
 * PortalShell.tsx: a native <dialog> for the mobile drawer, matchMedia to
 * drop back to the desktop layout, and a small inline icon set (see
 * ./icons.tsx) instead of adding a new icon library.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { PaIcon } from './icons';
import { isNavItemActive, pageNameFor, type PlatformNavHref } from '@/lib/platform/nav';

type NavItem = { href: string; label: string; icon: string; badge?: number };

function navItemsFor(schoolsCount: number): (NavItem & { href: PlatformNavHref })[] {
  return [
    { href: '/platform', label: 'Dashboard', icon: 'dashboard' },
    { href: '/platform/schools', label: 'Schools', icon: 'schools', badge: schoolsCount },
    { href: '/platform/schools/new', label: 'New school', icon: 'plus' },
    { href: '/platform/account/password', label: 'Password', icon: 'key' },
  ];
}

export default function PlatformShell({
  children,
  loginId,
  schoolsCount,
  endSession,
  fontClassName,
}: {
  children: React.ReactNode;
  loginId: string;
  schoolsCount: number;
  endSession: () => Promise<void>;
  /** next/font variable className (see ./font.ts) — applied on the shell root
   * so platform-shell.css's `var(--font-montserrat)` resolves everywhere,
   * including the native <dialog> mobile drawer portal-ed outside .pa-main. */
  fontClassName?: string;
}) {
  const pathname = usePathname();
  const navItems = navItemsFor(schoolsCount);
  const pageName = pageNameFor(pathname);
  // Per-route matching (src/lib/platform/nav.ts) — see nav.test.ts for the
  // exact bug this fixes: naive prefix matching made "Schools" and
  // "New school" active together.
  const matches = (href: PlatformNavHref) => isNavItemActive(href, pathname);

  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [signOutOpen, setSignOutOpen] = useState(false);

  const drawer = useRef<HTMLDialogElement>(null);
  const profileRef = useRef<HTMLDivElement>(null);
  const burger = useRef<HTMLButtonElement>(null);

  useEffect(() => { setMobileOpen(false); setProfileOpen(false); }, [pathname]);

  useEffect(() => {
    if (mobileOpen) drawer.current?.showModal();
    else drawer.current?.close();
    const previous = document.body.style.overflow;
    if (mobileOpen) document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [mobileOpen]);

  useEffect(() => {
    const media = window.matchMedia('(min-width: 901px)');
    const change = () => { if (media.matches) setMobileOpen(false); };
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (profileRef.current && !profileRef.current.contains(e.target as Node)) setProfileOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const initials = loginId.trim().slice(0, 2).toUpperCase();

  const navList = (onNavigate?: () => void) => (
    <>
      <div className="pa-nav-label">Navigation</div>
      {navItems.map((item) => {
        const active = matches(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            id={`pa-nav-${item.icon}`}
            onClick={onNavigate}
            title={collapsed && !mobileOpen ? item.label : undefined}
            className={`pa-nav-item${active ? ' pa-nav-item--active' : ''}${collapsed && !mobileOpen ? ' pa-nav-item--collapsed' : ''}`}
          >
            <span className="pa-nav-icon"><PaIcon name={item.icon} /></span>
            {(!collapsed || mobileOpen) && (
              <span className="pa-nav-label-text">{item.label}</span>
            )}
            {(!collapsed || mobileOpen) && typeof item.badge === 'number' && (
              <span className="pa-nav-badge">{item.badge}</span>
            )}
          </Link>
        );
      })}
    </>
  );

  const sidebarContents = (onNavigate?: () => void) => (
    <>
      <div className="pa-sidebar-head">
        <Link href="/platform" className="pa-brand" onClick={onNavigate}>
          <span className="pa-brand-mark">
            <PaIcon name="building" width={19} height={19} />
            <span className="pa-dot" />
          </span>
          {(!collapsed || mobileOpen) && (
            <span className="pa-brand-text">
              <span className="pa-brand-title">EduCBT <span className="pa-tag">Platform</span></span>
              <span className="pa-brand-sub">ADMIN CONSOLE</span>
            </span>
          )}
        </Link>
        <button type="button" className="pa-sidebar-close" onClick={() => setMobileOpen(false)} aria-label="Close menu">
          <PaIcon name="close" />
        </button>
      </div>

      <nav className="pa-nav" aria-label="Platform navigation">
        {navList(onNavigate)}
      </nav>

      <div className="pa-sidebar-foot">
        <form action={endSession}>
          <button
            type="submit"
            id="pa-sidebar-signout-btn"
            className={`pa-signout-btn${collapsed && !mobileOpen ? ' pa-nav-item--collapsed' : ''}`}
            title="Sign out"
          >
            <span className="pa-nav-icon"><PaIcon name="logout" /></span>
            {(!collapsed || mobileOpen) && <span>Sign out</span>}
          </button>
        </form>
        <div className="pa-collapse-btn-row">
          <button
            type="button"
            id="pa-sidebar-collapse-toggle"
            className="pa-collapse-btn"
            onClick={() => setCollapsed((c) => !c)}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            style={collapsed ? { width: '100%', justifyContent: 'center' } : undefined}
          >
            {collapsed ? <PaIcon name="chevronRight" /> : (
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                <span>Collapse menu</span>
                <PaIcon name="chevronLeft" />
              </span>
            )}
          </button>
        </div>
      </div>
    </>
  );

  return (
    <div className={`pa-shell${fontClassName ? ` ${fontClassName}` : ''}`}>
      {/* Desktop sidebar */}
      <aside id="pa-sidebar" className={`pa-sidebar${collapsed ? ' pa-sidebar--collapsed' : ''}`}>
        {sidebarContents()}
      </aside>

      {/* Mobile drawer (native dialog, same convention as the portal shell) */}
      <dialog
        ref={drawer}
        className="pa-drawer"
        aria-label="Platform navigation"
        onCancel={() => setMobileOpen(false)}
        onClose={() => { setMobileOpen(false); burger.current?.focus(); }}
      >
        <aside className="pa-sidebar" style={{ position: 'static', width: '100%', height: '100%' }}>
          {sidebarContents(() => setMobileOpen(false))}
        </aside>
      </dialog>

      <div className={`pa-main${collapsed ? ' pa-main--collapsed' : ''}`}>
        <header className="pa-header" id="pa-header">
          <div className="pa-header-left">
            <button
              ref={burger}
              type="button"
              className="pa-burger"
              aria-label="Open navigation"
              aria-expanded={mobileOpen}
              onClick={() => setMobileOpen(true)}
            >
              <PaIcon name="menu" />
            </button>
            <span className="pa-breadcrumb">
              <strong>EduCBT</strong>
              <PaIcon name="chevronRight" width={13} height={13} />
              <span>Platform</span>
              <PaIcon name="chevronRight" width={13} height={13} />
            </span>
            <span className="pa-page-name">{pageName}</span>
          </div>

          <div className="pa-profile-wrap" ref={profileRef}>
            <button
              type="button"
              id="pa-profile-btn"
              className="pa-profile-btn"
              aria-haspopup="true"
              aria-expanded={profileOpen}
              onClick={() => setProfileOpen((o) => !o)}
            >
              <span className="pa-avatar">{initials}</span>
              <span className="pa-profile-meta">
                <strong>{loginId}</strong>
                <span>Platform Admin</span>
              </span>
              <PaIcon name="chevronDown" width={14} height={14} style={{ transform: profileOpen ? 'rotate(180deg)' : undefined, transition: 'transform .15s' }} />
            </button>

            {profileOpen && (
              <div className="pa-dropdown" id="pa-profile-dropdown">
                <div className="pa-dropdown-head">
                  <div className="pa-dropdown-name">{loginId}</div>
                  <div className="pa-dropdown-role">Platform Administrator</div>
                </div>
                <Link href="/platform/account/profile" className="pa-dropdown-item" onClick={() => setProfileOpen(false)}>
                  <PaIcon name="userCheck" width={15} height={15} /> Profile & recovery email
                </Link>
                <Link href="/platform/account/security" className="pa-dropdown-item" onClick={() => setProfileOpen(false)}>
                  <PaIcon name="shield" width={15} height={15} /> Two-factor security
                </Link>
                <Link href="/platform/account/password" className="pa-dropdown-item" onClick={() => setProfileOpen(false)}>
                  <PaIcon name="key" width={15} height={15} /> Change password
                </Link>
                <button
                  type="button"
                  className="pa-dropdown-item pa-dropdown-item--danger"
                  onClick={() => { setProfileOpen(false); setSignOutOpen(true); }}
                >
                  <PaIcon name="logout" width={15} height={15} /> Sign out
                </button>
              </div>
            )}
          </div>
        </header>

        <main className="pa-body" id="pa-platform-main">{children}</main>
      </div>

      {signOutOpen && (
        <div className="pa-modal-backdrop" id="pa-signout-modal-backdrop" onClick={() => setSignOutOpen(false)}>
          <div className="pa-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="pa-modal-icon"><PaIcon name="logout" width={22} height={22} /></div>
            <h3>Sign out of EduCBT?</h3>
            <p>Your active Platform Administrator session will be securely closed on this device.</p>
            <div className="pa-modal-actions">
              <button type="button" className="pa-btn pa-btn--ghost pa-btn--block" onClick={() => setSignOutOpen(false)}>
                Cancel
              </button>
              <form action={endSession} className="pa-btn--block" style={{ flex: 1 }}>
                <button type="submit" className="pa-btn pa-btn--danger pa-btn--block">Sign out</button>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
