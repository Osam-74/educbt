/**
 * Paste-in-format and CSV parsing (legacy parity: parseObjectivePaste,
 * parseTheoryPaste and parseCSV / parseCSVLine in
 * templates/portal/exams/questions.php). Pure functions, shared by the
 * Paste and CSV import client components, so the format and its errors are
 * identical whichever way the text arrived.
 *
 * Sub-questions (legacy "1a. / 1b." theory breakdowns) are not carried by the
 * current schema — a theory question here is one stem and one mark value.
 * A pasted or imported sub-question line is reported as an error rather than
 * silently dropped, so the teacher knows to enter it as its own question.
 */

export type ParsedRow = {
  text: string;
  marks: number;
  markingGuide?: string;
  options?: Array<{ text: string; isCorrect: boolean }>;
  status: 'valid' | 'error';
  errors: string[];
};

function normalize(text: string): string {
  return text
    .replace(/\u2018|\u2019/g, "'")
    .replace(/\u201c|\u201d/g, '"')
    .replace(/\u00a0/g, ' ')
    .replace(/\u2013|\u2014/g, '-');
}

export function parseObjectivePaste(raw: string, defaultMarks: number): ParsedRow[] {
  const text = normalize(raw);
  const blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const results: ParsedRow[] = [];

  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    const row: ParsedRow = { text: '', marks: 0, options: [], status: 'valid', errors: [] };
    let correctLetter = '';

    for (const line of lines) {
      let m = line.match(/^(\d+)[.)]\s*(.*)/);
      if (m && !row.text) { row.text = m[2] ?? ''; continue; }

      m = line.match(/^([A-Fa-f])\s*[.)-]\s*(.*)/);
      if (m) { row.options!.push({ text: m[2] ?? '', isCorrect: false }); continue; }

      m = line.match(/^ANSWER\s*[:.]\s*([A-Fa-f])/i);
      if (m) { correctLetter = m[1]!.toUpperCase(); continue; }

      m = line.match(/^MARKS\s*[:.]\s*(\d+(?:\.\d+)?)/i);
      if (m) { row.marks = parseFloat(m[1]!); continue; }

      if (row.text && row.options!.length === 0) row.text += ' ' + line;
    }

    if (correctLetter) {
      const idx = correctLetter.charCodeAt(0) - 65;
      if (row.options![idx]) row.options![idx]!.isCorrect = true;
    }

    if (!row.text) { row.status = 'error'; row.errors.push('Missing question text.'); }
    if ((row.options ?? []).filter((o) => o.text.trim()).length < 2) { row.status = 'error'; row.errors.push('Needs at least two options.'); }
    if (!row.options!.some((o) => o.isCorrect)) { row.status = 'error'; row.errors.push('No correct answer — add an ANSWER: line (e.g. ANSWER: B).'); }
    if (!row.marks) row.marks = defaultMarks;

    results.push(row);
  }

  return results;
}

export function parseTheoryPaste(raw: string, defaultMarks: number): ParsedRow[] {
  const text = normalize(raw);
  const lines = text.split('\n');
  const results: ParsedRow[] = [];
  let row: ParsedRow | null = null;

  for (let line of lines) {
    line = line.trim();
    if (!line) continue;

    let m = line.match(/^(\d+)[.)]\s*(.*)/);
    if (m) {
      if (row) results.push(row);
      row = { text: m[2] ?? '', marks: 0, status: 'valid', errors: [] };
      continue;
    }

    m = line.match(/^(\d+)([a-z])[.)]\s*(.*)/i);
    if (m && row) {
      row.status = 'error';
      row.errors.push('Sub-questions (1a., 1b. …) are not supported — enter each as its own numbered question.');
      continue;
    }

    m = line.match(/^MARKS?\s*[:.]\s*(\d+(?:\.\d+)?)/i);
    if (m && row) { row.marks = parseFloat(m[1]!); continue; }

    if (row && row.text) row.text += ' ' + line;
  }
  if (row) results.push(row);

  for (const r of results) {
    if (!r.text) { r.status = 'error'; r.errors.push('Missing question text.'); }
    if (!r.marks) r.marks = defaultMarks;
  }

  return results;
}

/** One line of a CSV/Excel export, honouring quoted fields with embedded commas. */
export function parseCSVLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export function parseCSV(raw: string, isTheory: boolean, defaultMarks: number): ParsedRow[] {
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const header = parseCSVLine(lines[0]!).map((h) => h.toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const results: ParsedRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = parseCSVLine(lines[i]!);
    const get = (name: string) => { const idx = col(name); return idx === -1 ? '' : (cells[idx] ?? '').trim(); };

    if (isTheory) {
      const row: ParsedRow = { text: get('question'), marks: parseFloat(get('marks')) || 0, markingGuide: get('marking_guide') || undefined, status: 'valid', errors: [] };
      if (!row.text) { row.status = 'error'; row.errors.push('Missing question text.'); }
      if (get('sub_questions')) { row.status = 'error'; row.errors.push('Sub-questions are not supported — split into separate rows.'); }
      if (!row.marks) row.marks = defaultMarks;
      results.push(row);
    } else {
      const options = ['option_a', 'option_b', 'option_c', 'option_d'].map((k) => get(k));
      const correct = get('correct_option').toUpperCase();
      const correctIdx = correct ? correct.charCodeAt(0) - 65 : -1;
      const row: ParsedRow = {
        text: get('question'),
        marks: parseFloat(get('marks')) || 0,
        options: options.map((t, idx) => ({ text: t, isCorrect: idx === correctIdx })),
        status: 'valid', errors: [],
      };
      if (!row.text) { row.status = 'error'; row.errors.push('Missing question text.'); }
      if (row.options!.filter((o) => o.text.trim()).length < 2) { row.status = 'error'; row.errors.push('Needs at least two options.'); }
      if (correctIdx < 0 || !row.options![correctIdx]?.text.trim()) { row.status = 'error'; row.errors.push('correct_option does not match a filled option.'); }
      if (!row.marks) row.marks = defaultMarks;
      results.push(row);
    }
  }

  return results;
}

export const CSV_TEMPLATE = {
  objective: 'question,option_a,option_b,option_c,option_d,correct_option,marks\n'
    + '"What is 2+2?","1","2","3","4","D","2"\n"Capital of Nigeria?","Lagos","Abuja","Kano","Port Harcourt","B","1"',
  theory: 'question,marks,marking_guide\n'
    + '"Explain photosynthesis",10,"Light energy converted to chemical energy..."\n"Define gravity",5,"Force of attraction between masses..."',
};

export const PASTE_GUIDE = {
  objective: '1. What is the capital of Nigeria?\nA) Lagos\nB) Abuja\nC) Kano\nD) Port Harcourt\nANSWER: B\nMARKS: 2\n\n2. Which gas do plants absorb?\nA) Oxygen\nB) Nitrogen\nC) Carbon dioxide\nD) Hydrogen\nANSWER: C',
  theory: '1. Explain three causes of the Nigerian Civil War.\nMARKS: 9\n\n2. With a labelled diagram, describe the structure of a plant cell.\nMARKS: 12',
};
