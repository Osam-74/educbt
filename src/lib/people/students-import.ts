/**
 * The bulk-import CSV contract (legacy educbt_import_students): four template
 * columns, an RFC-4180 reader. Kept in its own module with NO database
 * imports so the template-download route can share the exact header without
 * dragging the postgres client into build-time page-data collection.
 */

// ── Bulk import (legacy educbt_import_students). ─────────────────────────────

/** The template's four columns — admission numbers and passwords are
 *  generated, never typed, exactly as the plugin's copy promises. */
export const IMPORT_COLUMNS = ['first_name', 'last_name', 'gender', 'date_of_birth'] as const;

export type ImportRow = {
  firstName: string;
  lastName: string;
  gender?: string;
  dateOfBirth?: string;
};

export type ImportOutcome = {
  row: number; // 1-based data row in the CSV (after the header)
  ok: boolean;
  admissionNumber?: string;
  initialPassword?: string;
  error?: string;
};

/**
 * A small RFC-4180 reader: quoted fields, doubled quotes, commas and CRLF
 * inside quotes. Spreadsheets in the wild quote inconsistently, and a
 * student named "Ojo, Ade" must survive row 3.
 */
export function parseStudentCsv(text: string): { rows: ImportRow[]; errors: Array<{ row: number; error: string }> } {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let rowStart = true;

  const endField = () => { record.push(field); field = ''; };
  const endRecord = () => { endField(); records.push(record); record = []; };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') { inQuotes = true; rowStart = false; continue; }
    if (ch === ',') { endField(); rowStart = false; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { if (!rowStart || record.length || field) endRecord(); rowStart = true; continue; }
    field += ch;
    rowStart = false;
  }
  if (field !== '' || record.length) endRecord();

  const errors: Array<{ row: number; error: string }> = [];
  const rows: ImportRow[] = [];
  if (records.length === 0) return { rows, errors: [{ row: 1, error: 'The file is empty.' }] };

  // Header: accept the four template columns in any order; a missing
  // first_name or last_name column is a template problem, not bad data.
  const header = records[0]!.map((h) => h.trim().toLowerCase());
  if (!header.includes('first_name') || !header.includes('last_name')) {
    return { rows, errors: [{ row: 1, error: 'The header row must include first_name and last_name columns. Download the template.' }] };
  }
  const idx = {
    firstName: header.indexOf('first_name'),
    lastName: header.indexOf('last_name'),
    gender: header.indexOf('gender'),
    dateOfBirth: header.indexOf('date_of_birth'),
  };

  for (let r = 1; r < records.length; r++) {
    const cells = records[r]!;
    if (cells.every((c) => c.trim() === '')) continue; // trailing blank line
    rows.push({
      firstName: (cells[idx.firstName] ?? '').trim(),
      lastName: (cells[idx.lastName] ?? '').trim(),
      gender: idx.gender >= 0 ? (cells[idx.gender] ?? '').trim() : '',
      dateOfBirth: idx.dateOfBirth >= 0 ? (cells[idx.dateOfBirth] ?? '').trim() : '',
    });
  }
  return { rows, errors };
}

