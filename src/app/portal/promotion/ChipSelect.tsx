'use client';
/**
 * Chip-select multi-select (legacy EduCBT Pro parity: includes/Frontend/ChipField.php).
 * The same pill picker the plugin uses for "subjects that must be passed" on the
 * promotion rules form — a box that opens a dropdown, and every chosen value
 * becomes a removable pill inside the box.
 */
import { useEffect, useRef, useState } from 'react';

export type ChipOption = { value: string; label: string };

export default function ChipSelect({ name, options, selected, placeholder = 'Click to select…' }: {
  name: string; options: ChipOption[]; selected: string[]; placeholder?: string;
}) {
  const [values, setValues] = useState<string[]>(selected);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => setValues(selected), [selected]);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, []);

  const toggle = (value: string) =>
    setValues(prev => prev.includes(value) ? prev.filter(v => v !== value) : [...prev, value]);
  const label = (value: string) => options.find(o => o.value === value)?.label ?? value;

  return <div className="chip-select" ref={box}>
    <button type="button" className="chip-select__input" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="chip-select__chips">
        {values.map(v => <span key={v} className="chip-select__chip" data-chip-value={v}>
          {label(v)}
          <span className="chip-select__remove" role="button" tabIndex={-1} aria-label="Remove"
            onClick={e => { e.preventDefault(); e.stopPropagation(); toggle(v); }}>×</span>
        </span>)}
      </span>
      {values.length === 0 && <span className="chip-select__placeholder">{placeholder}</span>}
      <svg className="chip-select__arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
    </button>
    <div className="chip-select__dropdown" hidden={!open}>
      {options.map(opt => <div key={opt.value} className={'chip-select__option' + (values.includes(opt.value) ? ' is-selected' : '')}
        role="option" aria-selected={values.includes(opt.value)} onClick={() => toggle(opt.value)}>{opt.label}</div>)}
    </div>
    {values.map(v => <input key={v} type="hidden" name={name} value={v}/>)}
  </div>;
}
