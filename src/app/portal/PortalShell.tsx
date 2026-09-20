'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import PendingButton from '@/app/PendingButton';
import { useEffect, useRef, useState } from 'react';

export const roleLabels: Record<string, string> = { principal: 'Principal', vice_principal: 'Vice Principal', exam_officer: 'Examination Officer', teacher: 'Teacher', student: 'Student', parent: 'Parent' };
type Item = { href: string; label: string; icon: string };
type Area = { label: string; items: Item[] };
const item = (path: string, label: string, icon = 'grid'): Item => ({ href: '/portal' + path, label, icon });
export function portalAreas(role: string, teaching: boolean, classTeacher: boolean): Area[] {
  const wide = ['principal', 'vice_principal', 'exam_officer'].includes(role);
  const areas: Area[] = [];
  // Legacy parity: the plugin's School area has NO score-entry item —
  // recording scores is Teaching work, shown only where the teacher does it.
  if (wide) areas.push({ label: 'School', items: [item('', 'Overview', 'area:school'), item('/staff', 'Staff', 'staff'), item('/students', 'Students', 'students'), item('/classes', 'Classes', 'classes'), item('/subjects', 'Subjects', 'subjects'), item('/results', 'Results', 'results'), item('/broadsheet', 'Broadsheet', 'broadsheet'), ...(role === 'principal' || role === 'vice_principal' ? [item('/promotion', 'Promotion', 'promotion')] : []), ...(role === 'principal' ? [item('/transcripts', 'Transcripts', 'transcripts')] : []), ...(role === 'principal' || role === 'vice_principal' ? [item('/activity', 'Activity log', 'activity')] : [])] });
  // "My assignments" / "My students" share a route with the School area's own
  // "Classes" / "Students" pages (?scope=mine forces the teacher-owned view —
  // see /portal/classes and /portal/students — for a wide role that also
  // teaches; a no-op for a plain teacher, who always gets that view anyway).
  // Dashboard: a plain teacher's own '/portal' already resolves to
  // TeacherDashboard with no scope needed. A wide role who ALSO teaches
  // reaches the SAME '/portal' route from School > Overview, so their
  // Teaching > Dashboard needs ?scope=mine to land on TeacherDashboard
  // instead of the office overview they'd otherwise get by default.
  const teachingDashboardHref = wide && teaching ? '?scope=mine' : '';
  // Legacy PortalRouter's 'teacher' menu (for reference, matched item-for-item
  // as each is built): Dashboard, Subject Registration, My Assignments,
  // Subject Results, Record Scores, My Students*, Class Results*, Signature*,
  // Remarks* (* = requires_class_teacher). Class Results is not yet built -
  // add it here, in that slot, when it lands.
  if (role === 'teacher' || role === 'exam_officer' || (wide && teaching)) areas.push({ label: 'Teaching', items: [item(teachingDashboardHref, 'Dashboard', 'area:teacher'), item('/registration', 'Subject Registration', 'edit'), item('/classes?scope=mine', 'My assignments', 'classes'), item('/analysis', 'Subject Results', 'results'), item('/ca', 'Record scores', 'scores'), ...(classTeacher || wide ? [item('/students?scope=mine', 'My students', 'students')] : []), ...(role === 'teacher' && classTeacher ? [item('/signature', 'Signature', 'edit'), item('/remarks', 'Remarks', 'edit')] : [])] });
  if (wide) areas.find(a => a.label === 'School')!.items.push(item('/settings', 'School Settings', 'settings'));
  // Legacy parity (PortalRouter::sections()['exams']): Overview, Question
  // Bank, Approve Questions, Exam Papers, Timetable, Invigilation Schedule,
  // Test/Exam Sessions, Marking Status — same order, names and icon keys as
  // the plugin. Overview / Approve Questions / Exam Papers stay wide-only,
  // matching the existing route guards (requireRole(actor, SCHOOL_WIDE)).
  // "Test/Exam Sessions" is the session-history search + reattempt page —
  // the plugin folds its own live board into that same page (its
  // `invigilate` section is "Hidden from nav — merged into Test/Exam
  // Sessions"). An in-progress result links straight to the live watch
  // page (/invigilate/[paperId]).
  if (wide || role === 'teacher') areas.push({ label: 'Examinations', items: [
    ...(wide ? [item('/exams', 'Overview', 'grid')] : []),
    item('/questions', 'Question Bank', 'questions'),
    ...(wide ? [item('/exams/approvals', 'Approve Questions', 'approvals')] : []),
    ...(wide ? [item('/exams/papers', 'Exam Papers', 'papers')] : []),
    item('/timetable', 'Timetable', 'timetable'),
    item('/invigilation', 'Invigilation Schedule', 'invigilation'),
    item('/invigilate', 'Test/Exam Sessions', 'sessions'),
    item('/marking', 'Marking Status', 'marking'),
  ] });
  if (role === 'student') areas.push({ label: 'Student', items: [item('', 'Dashboard', 'area:student'), item('/my-results', 'My results', 'results'), item('/practice', 'Practice', 'tests')] });
  if (role === 'parent') areas.push({ label: 'Parent', items: [item('', 'Dashboard', 'area:guardian'), item('/children', 'My children', 'children'), item('/timetable', 'Exam timetable', 'timetable')] });
  // Communications are for everyone: the inbox, the announcements board and
  // (for staff and parents) messages. Added as its own area so the sidebar
  // never buries the unread count.
  const msgRoles = ['principal', 'vice_principal', 'exam_officer', 'teacher', 'parent'];
  areas.push({ label: 'Communications', items: [item('/notifications', 'Notifications', 'notices'), item('/announcements', 'Announcements', 'notices'), ...(msgRoles.includes(role) ? [item('/messages', 'Messages', 'edit')] : [])] });
  return areas.length ? areas : [{ label: 'Account', items: [item('', 'Dashboard')] }];
}
export function PortalIcon({ name }: { name: string }) {
  // Legacy EduCBT Pro parity: the plugin's icon set (templates/portal/shell.php,
  // $educbt_icon_paths) ported verbatim — every menu keeps its original icon.
  const icons: Record<string, string> = {
    'area:school': '<path d="M4 21V9.5l8-5 8 5V21"/><path d="M9 21v-6h6v6"/>',
    'area:exams': '<path d="M8 3h6l4 4v14H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M14 3v4h4"/>',
    'area:teacher': '<rect x="3" y="4" width="18" height="12" rx="1.6"/><path d="M9 20h6M12 16v4"/>',
    'area:student': '<path d="M12 4 2 9l10 5 10-5-10-5Z"/><path d="M6 11.4V17c0 1.4 2.7 3 6 3s6-1.6 6-3v-5.6"/>',
    'area:guardian': '<path d="M12 20s-7.4-4.4-9.7-8.9C.7 8 2.5 4.8 6 4.8c2 0 3.4 1.2 6 3.6 2.6-2.4 4-3.6 6-3.6 3.5 0 5.3 3.2 3.7 6.3C19.4 15.6 12 20 12 20Z"/>',
    grid: '<rect x="3" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6"/>',
    staff: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.6 2.7-6.4 6-6.4s6 2.8 6 6.4"/>',
    students: '<path d="M12 4 2 9l10 5 10-5-10-5Z"/><path d="M6 11.4V17c0 1.4 2.7 3 6 3s6-1.6 6-3v-5.6"/>',
    classes: '<path d="M12 3 3 8l9 5 9-5-9-5Z"/><path d="M3 12l9 5 9-5"/>',
    subjects: '<path d="M4 4.6A2.6 2.6 0 0 1 6.6 2H20v17H6.6A2.6 2.6 0 0 0 4 21.6v-17Z"/>',
    results: '<path d="M4 20V10M12 20V4M20 20v-7"/><path d="M2 20h20"/>',
    promotion: '<path d="M3 17l6-6 4 4 7-8"/><path d="M15 6.5h5.5V12"/>',
    transcripts: '<path d="M14 2H7.5A2 2 0 0 0 5.5 4v16a2 2 0 0 0 2 2H17a2 2 0 0 0 2-2V8l-5-6Z"/><path d="M14 2v6h5"/>',
    notices: '<path d="M3 10.2v3.6h3l4.3 4.3V5.9L6 10.2H3Z"/><path d="M14.3 8.3a4.3 4.3 0 0 1 0 7.4"/>',
    activity: '<path d="M3 12h4l2-7 4 14 2-7h6"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
    papers: '<path d="M14 2H7.5A2 2 0 0 0 5.5 4v16a2 2 0 0 0 2 2H17a2 2 0 0 0 2-2V8l-5-6Z"/><path d="M14 2v6h5"/>',
    timetable: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
    questions: '<circle cx="12" cy="12" r="9"/><path d="M9.3 9.2a2.7 2.7 0 0 1 5 1.4c0 1.9-2.2 1.8-2.7 3.4"/><path d="M12 17h.01"/>',
    approvals: '<circle cx="12" cy="12" r="9"/><path d="M8 12.3l2.6 2.6L16 9.3"/>',
    invigilate: '<path d="M2 12s3.6-7.2 10-7.2 10 7.2 10 7.2-3.6 7.2-10 7.2-10-7.2-10-7.2Z"/><circle cx="12" cy="12" r="3"/>',
    invigilation: '<path d="M2 12s3.6-7.2 10-7.2 10 7.2 10 7.2-3.6 7.2-10 7.2-10-7.2-10-7.2Z"/><circle cx="12" cy="12" r="3"/>',
    sessions: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
    marking: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z"/>',
    broadsheet: '<rect x="3" y="4" width="18" height="16" rx="1.6"/><path d="M3 10h18M9 4v16"/>',
    analysis: '<path d="M4 19V9M10 19V5M16 19v-7"/><path d="M2 19h20"/>',
    scores: '<path d="M9 6h11M9 12h11M9 18h11"/>',
    register: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4a3 3 0 0 1 6 0"/><path d="M8 12.5h8M8 16.5h5"/>',
    tests: '<path d="M14 2H7.5A2 2 0 0 0 5.5 4v16a2 2 0 0 0 2 2H17a2 2 0 0 0 2-2V8l-5-6Z"/><path d="M14 2v6h5"/>',
    exam: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z"/>',
    children: '<path d="M12 20s-7.4-4.4-9.7-8.9C.7 8 2.5 4.8 6 4.8c2 0 3.4 1.2 6 3.6 2.6-2.4 4-3.6 6-3.6 3.5 0 5.3 3.2 3.7 6.3C19.4 15.6 12 20 12 20Z"/>',
    // Legacy aliases used by dashboards and other call sites.
    person: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.6 2.7-6.4 6-6.4s6 2.8 6 6.4"/>',
    school: '<path d="M12 4 2 9l10 5 10-5-10-5Z"/><path d="M6 11.4V17c0 1.4 2.7 3 6 3s6-1.6 6-3v-5.6"/>',
    layers: '<path d="M12 3 3 8l9 5 9-5-9-5Z"/><path d="M3 12l9 5 9-5"/>',
    chart: '<path d="M4 20V10M12 20V4M20 20v-7"/><path d="M2 20h20"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="M8 12.3l2.6 2.6L16 9.3"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  };
  const body = icons[name] ?? icons.grid ?? '';
  return <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: body }} />;
}

export default function PortalShell({ children, school, displayName, role, sessionTitle, termTitle, teaching, classTeacher, signOut, unread = 0 }: { children: React.ReactNode; school: string; displayName: string; role: string; sessionTitle: string; termTitle: string; teaching: boolean; classTeacher: boolean; signOut: () => Promise<void>; unread?: number }) {
  const pathname = usePathname();
  // Only the 'scope' param disambiguates two nav items that share a route
  // (Classes/Students vs My assignments/My students) — every other query
  // param a page keeps for its own filters (search, status, ...) must NOT
  // affect which sidebar item lights up.
  const currentScope = useSearchParams().get('scope') ?? '';
  const splitHref = (href: string) => {
    const q = href.indexOf('?');
    if (q === -1) return { path: href, scope: '' };
    return { path: href.slice(0, q), scope: new URLSearchParams(href.slice(q + 1)).get('scope') ?? '' };
  };
  const areas = portalAreas(role, teaching, classTeacher);
  const allItems = areas.flatMap(a => a.items);
  const activeHref = allItems
    .map(i => i.href)
    .filter(href => {
      const { path, scope } = splitHref(href);
      if (pathname === path) return scope === currentScope;
      return path !== '/portal' && pathname.startsWith(path + '/');
    })
    .sort((a, b) => b.length - a.length)[0];
  const matches = (href: string) => href === activeHref;
  const automatic = areas.find(a => a.items.some(i => matches(i.href)))?.label ?? areas[0]!.label;
  const [selected, setSelected] = useState<string | null>(null);
  const area = areas.find(a => a.label === selected) ?? areas.find(a => a.label === automatic)!;
  const [open, setOpen] = useState(false);
  const drawer = useRef<HTMLDialogElement>(null);
  const burger = useRef<HTMLButtonElement>(null);
  useEffect(() => { setSelected(null); setOpen(false); }, [pathname]);
  useEffect(() => {
    if (open) drawer.current?.showModal(); else drawer.current?.close();
    const previous = document.body.style.overflow;
    if (open) document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [open]);
  useEffect(() => { const media = window.matchMedia('(min-width: 901px)'); const change = () => { if (media.matches) setOpen(false); }; media.addEventListener('change', change); return () => media.removeEventListener('change', change); }, []);
  const title = pathname === '/portal' ? (role === 'principal' ? "Principal’s Dashboard" : `${roleLabels[role] ?? 'Your'} Dashboard`) : allItems.find(i => i.href === activeHref)?.label ?? 'My account';
  const initials = displayName.trim().split(/\s+/).slice(0, 2).map(n => n[0]).join('').toUpperCase();
  const navigation = () => <>
    <div className="ps-brand"><span className="ps-brand-mark"><PortalIcon name="school"/></span><div><strong>EduCBT</strong><span>School portal</span></div></div>
    <div className="ps-school"><strong>{roleLabels[role] ?? role}</strong><span>{school}</span></div>
    <div className="ps-scroll">
      {areas.length > 1 && <div className="ps-areas"><p className="ps-label">Areas</p><div role="group" aria-label="Portal areas">{areas.map(a => <button type="button" key={a.label} aria-pressed={area.label === a.label} onClick={() => setSelected(a.label)}><PortalIcon name={a.label === 'School' ? 'school' : 'book'}/>{a.label}</button>)}</div></div>}
      <nav aria-label={`${area.label} navigation`}><p className="ps-label">{area.label}</p>{area.items.map(i => <Link key={i.href} href={i.href} aria-current={matches(i.href) ? 'page' : undefined} onClick={() => setOpen(false)}><PortalIcon name={i.icon}/>{i.label}</Link>)}</nav>
    </div>
    <div className="ps-profile"><Link href="/portal/account/password" onClick={() => setOpen(false)}><span className="ps-avatar">{initials}</span><span><strong>{displayName}</strong><small>{roleLabels[role] ?? role} · My account</small></span></Link><form action={signOut}><PendingButton pendingLabel="Signing out…">Sign out</PendingButton></form></div>
  </>;
  return <div className="portal portal-shell">
    <a className="ps-skip" href="#portal-main">Skip to content</a>
    <aside className="ps-sidebar">{navigation()}</aside>
    <dialog ref={drawer} className="ps-drawer" aria-label="Portal navigation" onCancel={() => setOpen(false)} onClose={() => { setOpen(false); burger.current?.focus(); }} onClick={e => { if (e.target === e.currentTarget) setOpen(false); }}><div className="ps-drawer-inner"><button className="ps-close" type="button" onClick={() => setOpen(false)}>Close menu ×</button>{navigation()}</div></dialog>
    <div className="ps-workspace"><header className="ps-topbar"><button ref={burger} className="ps-burger" type="button" aria-label="Open navigation" aria-expanded={open} onClick={() => setOpen(true)}><PortalIcon name="menu"/></button><strong>{title}</strong><span className="ps-context"><span className="ps-chip"><PortalIcon name="calendar"/>{sessionTitle}</span><span className="ps-chip"><PortalIcon name="clock"/>{termTitle}</span></span><Link className="ps-bell" href="/portal/notifications" aria-label={`${unread} unread notifications`}>{unread > 0 ? <span className="ps-badge">{unread}</span> : null}<PortalIcon name="activity"/></Link></header><main id="portal-main" className="portal__body" tabIndex={-1}>{children}</main></div>
  </div>;
}
