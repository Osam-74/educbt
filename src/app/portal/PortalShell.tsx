'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

export const roleLabels: Record<string, string> = { principal: 'Principal', vice_principal: 'Vice Principal', exam_officer: 'Examination Officer', teacher: 'Teacher', student: 'Student', parent: 'Parent' };
type Item = { href: string; label: string; icon: string };
type Area = { label: string; items: Item[] };
const item = (path: string, label: string, icon = 'grid'): Item => ({ href: '/portal' + path, label, icon });
export function portalAreas(role: string, teaching: boolean, classTeacher: boolean): Area[] {
  const wide = ['principal', 'vice_principal', 'exam_officer'].includes(role);
  const areas: Area[] = [];
  if (wide) areas.push({ label: 'School', items: [item('', 'Overview'), item('/staff', 'Staff', 'person'), item('/students', 'Students', 'school'), item('/classes', 'Classes', 'layers'), item('/subjects', 'Subjects', 'book'), item('/results', 'Results', 'chart'), item('/review', 'Review', 'check'), item('/broadsheet', 'Broadsheet', 'grid'), item('/ca', 'Record scores', 'edit')] });
  if (role === 'teacher' || role === 'exam_officer' || (wide && teaching)) areas.push({ label: 'Teaching', items: [item('', 'Dashboard'), item('/classes', 'My assignments', 'layers'), ...(classTeacher || wide ? [item('/students', 'My students', 'school')] : []), item('/ca', 'Record scores', 'edit')] });
  if (wide || role === 'teacher') areas.push({ label: 'Examinations', items: [...(wide ? [item('/exams', 'Exam office', 'book')] : []), item('/questions', 'Question Bank', 'book'), item('/marking', 'Marking', 'edit')] });
  if (wide) areas.find(a => a.label === 'School')!.items.push(item('/settings', 'School Settings', 'edit'));
  else if (role === 'teacher' && classTeacher) areas.find(a => a.label === 'Teaching')!.items.push(item('/settings', 'Signatures & remarks', 'edit'));
  if (role === 'student') areas.push({ label: 'Student', items: [item('', 'Dashboard'), item('/practice', 'Practice', 'edit')] });
  if (role === 'parent') areas.push({ label: 'Parent', items: [item('', 'Dashboard')] });
  return areas.length ? areas : [{ label: 'Account', items: [item('', 'Dashboard')] }];
}
export function PortalIcon({ name }: { name: string }) {
  const paths: Record<string, string> = { grid: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z', person: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M5 21v-2a7 7 0 0 1 14 0v2', school: 'M2 8l10-5 10 5-10 5z M6 11v6q6 5 12 0v-6', layers: 'M3 7l9-5 9 5-9 5z M3 12l9 5 9-5 M3 17l9 5 9-5', book: 'M4 4h7q1 0 1 2 0-2 1-2h7v15h-7q-1 0-1 2 0-2-1-2H4z M12 6v15', chart: 'M4 20V10 M12 20V4 M20 20v-7 M2 20h20', check: 'M4 12l5 5L20 6', edit: 'M14 5l5 5 M4 20l4-1L21 6l-4-4L4 15z', clock: 'M12 7v5l4 2 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0', calendar: 'M3 5h18v16H3z M7 2v6 M17 2v6 M3 11h18', activity: 'M2 12h5l3-8 4 16 3-8h5', menu: 'M4 6h16 M4 12h16 M4 18h16' };
  return <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name] ?? paths.grid}/></svg>;
}

export default function PortalShell({ children, school, displayName, role, calendar, teaching, classTeacher, signOut }: { children: React.ReactNode; school: string; displayName: string; role: string; calendar: string; teaching: boolean; classTeacher: boolean; signOut: () => Promise<void> }) {
  const pathname = usePathname();
  const areas = portalAreas(role, teaching, classTeacher);
  const matches = (href: string) => pathname === href || (href !== '/portal' && pathname.startsWith(href + '/'));
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
  const title = pathname === '/portal' ? (role === 'principal' ? "Principal’s Dashboard" : `${roleLabels[role] ?? 'Your'} Dashboard`) : areas.flatMap(a => a.items).find(i => matches(i.href))?.label ?? 'My account';
  const initials = displayName.trim().split(/\s+/).slice(0, 2).map(n => n[0]).join('').toUpperCase();
  const navigation = () => <>
    <div className="ps-brand"><span className="ps-brand-mark"><PortalIcon name="school"/></span><div><strong>EduCBT</strong><span>School portal</span></div></div>
    <div className="ps-school"><strong>{roleLabels[role] ?? role}</strong><span>{school}</span></div>
    <div className="ps-scroll">
      {areas.length > 1 && <div className="ps-areas"><p className="ps-label">Areas</p><div role="group" aria-label="Portal areas">{areas.map(a => <button type="button" key={a.label} aria-pressed={area.label === a.label} onClick={() => setSelected(a.label)}><PortalIcon name={a.label === 'School' ? 'school' : 'book'}/>{a.label}</button>)}</div></div>}
      <nav aria-label={`${area.label} navigation`}><p className="ps-label">{area.label}</p>{area.items.map(i => <Link key={i.href} href={i.href} aria-current={matches(i.href) ? 'page' : undefined} onClick={() => setOpen(false)}><PortalIcon name={i.icon}/>{i.label}</Link>)}</nav>
    </div>
    <div className="ps-profile"><Link href="/portal/account/password" onClick={() => setOpen(false)}><span className="ps-avatar">{initials}</span><span><strong>{displayName}</strong><small>{roleLabels[role] ?? role} · My account</small></span></Link><form action={signOut}><button type="submit">Sign out</button></form></div>
  </>;
  return <div className="portal portal-shell">
    <a className="ps-skip" href="#portal-main">Skip to content</a>
    <aside className="ps-sidebar">{navigation()}</aside>
    <dialog ref={drawer} className="ps-drawer" aria-label="Portal navigation" onCancel={() => setOpen(false)} onClose={() => { setOpen(false); burger.current?.focus(); }} onClick={e => { if (e.target === e.currentTarget) setOpen(false); }}><div className="ps-drawer-inner"><button className="ps-close" type="button" onClick={() => setOpen(false)}>Close menu ×</button>{navigation()}</div></dialog>
    <div className="ps-workspace"><header className="ps-topbar"><button ref={burger} className="ps-burger" type="button" aria-label="Open navigation" aria-expanded={open} onClick={() => setOpen(true)}><PortalIcon name="menu"/></button><strong>{title}</strong><span className="ps-context">{calendar}</span></header><main id="portal-main" className="portal__body" tabIndex={-1}>{children}</main></div>
  </div>;
}
