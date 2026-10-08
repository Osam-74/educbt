'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { searchEntries, type SearchEntry } from '@/lib/help/search';

/**
 * Search box with live suggestions. It only ever receives the compact index
 * (title / description / category / keywords), never article bodies, so the
 * Help pages stay light. Enter or the button goes to the full results page,
 * which also searches the article text.
 */
export function HelpSearch({
  index, initial = '', autoFocus = false, size = 'lg',
}: { index: SearchEntry[]; initial?: string; autoFocus?: boolean; size?: 'lg' | 'sm' }) {
  const router = useRouter();
  const [q, setQ] = useState(initial);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const box = useRef<HTMLDivElement>(null);

  const results = useMemo(() => (q.trim().length >= 2 ? searchEntries(index, q, 6) : []), [index, q]);

  useEffect(() => {
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, []);

  function go(e?: React.FormEvent) {
    e?.preventDefault();
    const term = q.trim();
    if (active >= 0 && results[active]) {
      router.push(`/help/${results[active].category}/${results[active].slug}`);
    } else if (term) {
      router.push(`/help/search?q=${encodeURIComponent(term)}`);
    }
    setOpen(false);
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, -1)); }
    else if (e.key === 'Escape') { setOpen(false); setActive(-1); }
  }

  const showList = open && q.trim().length >= 2;

  return (
    <div className={`hc-search hc-search--${size}`} ref={box}>
      <form role="search" onSubmit={go} className="hc-search__form">
        <svg aria-hidden="true" viewBox="0 0 24 24" className="hc-search__icon"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" /><path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
        <input
          type="search" value={q} autoFocus={autoFocus} autoComplete="off"
          placeholder="Search the Help Center, e.g. reset password"
          aria-label="Search the Help Center" aria-expanded={showList} aria-controls="hc-suggest" aria-autocomplete="list"
          onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(-1); }}
          onFocus={() => setOpen(true)} onKeyDown={onKey}
        />
        <button type="submit">Search</button>
      </form>
      {showList && (
        <ul id="hc-suggest" role="listbox" className="hc-suggest">
          {results.length === 0 ? (
            <li className="hc-suggest__none">No quick matches. Press Enter to search the full text.</li>
          ) : results.map((r, i) => (
            <li key={r.slug} role="option" aria-selected={i === active}>
              <a href={`/help/${r.category}/${r.slug}`} className={i === active ? 'is-active' : ''} onMouseEnter={() => setActive(i)}>
                <strong>{r.title}</strong>
                <span>{r.categoryTitle}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
