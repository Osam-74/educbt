/**
 * The standard subject offering — ported from the legacy plugin's
 * SubjectSeederService. One-time seeding for a newly onboarded school: a
 * school arriving at an empty system would otherwise have to type thirty-odd
 * subjects before it can do anything else, and every school types very
 * nearly the same list.
 *
 * The list is based on the NERDC offering for Nigerian secondary schools:
 * junior subjects common to JSS 1–3, and senior subjects grouped by the
 * Science, Arts/Humanities and Business/Commercial streams. Core subjects
 * are marked compulsory so subject registration assigns them automatically.
 *
 * Nigeria approved a revised curriculum for 2025/2026 which renames and
 * consolidates several subjects. Schools are mid-transition, so the list
 * below keeps the names schools currently use and recognise. Anything here
 * can be renamed, retired or added to afterwards — it is a starting point,
 * not a fixture.
 */

export type StandardSubject = {
  name: string;
  code: string;
  stage: 'junior' | 'senior';
  /** Senior subjects attach to a matching department where one exists. */
  stream?: 'science' | 'arts' | 'business';
  core?: boolean;
};

export const STANDARD_SUBJECTS: StandardSubject[] = [
  // ── Junior secondary (JSS 1–3) ────────────────────────────────────
  { name: 'English Studies', code: 'ENG-J', stage: 'junior', core: true },
  { name: 'Mathematics', code: 'MTH-J', stage: 'junior', core: true },
  { name: 'Basic Science', code: 'BSC', stage: 'junior', core: true },
  { name: 'Basic Technology', code: 'BTC', stage: 'junior', core: true },
  { name: 'Social Studies', code: 'SOS', stage: 'junior', core: true },
  { name: 'Civic Education', code: 'CVE-J', stage: 'junior', core: true },
  { name: 'Business Studies', code: 'BUS-J', stage: 'junior', core: true },
  { name: 'Agricultural Science', code: 'AGR-J', stage: 'junior', core: true },
  { name: 'Physical and Health Education', code: 'PHE-J', stage: 'junior', core: true },
  { name: 'Cultural and Creative Arts', code: 'CCA', stage: 'junior', core: true },
  { name: 'Computer Studies', code: 'CMP-J', stage: 'junior', core: true },
  { name: 'Home Economics', code: 'HEC-J', stage: 'junior' },
  { name: 'Christian Religious Studies', code: 'CRS-J', stage: 'junior' },
  { name: 'Islamic Studies', code: 'IRS-J', stage: 'junior' },
  { name: 'Nigerian Language', code: 'NLG-J', stage: 'junior' },
  { name: 'French', code: 'FRN-J', stage: 'junior' },
  { name: 'History', code: 'HIS-J', stage: 'junior' },

  // ── Senior secondary — compulsory for every stream ─────────────────
  { name: 'English Language', code: 'ENG', stage: 'senior', core: true },
  { name: 'General Mathematics', code: 'MTH', stage: 'senior', core: true },
  { name: 'Civic Education', code: 'CVE', stage: 'senior', core: true },

  // ── Senior — Science ──────────────────────────────────────────────
  { name: 'Physics', code: 'PHY', stage: 'senior', stream: 'science' },
  { name: 'Chemistry', code: 'CHM', stage: 'senior', stream: 'science' },
  { name: 'Biology', code: 'BIO', stage: 'senior', stream: 'science' },
  { name: 'Further Mathematics', code: 'FMT', stage: 'senior', stream: 'science' },
  { name: 'Agricultural Science', code: 'AGR', stage: 'senior', stream: 'science' },
  { name: 'Technical Drawing', code: 'TDR', stage: 'senior', stream: 'science' },

  // ── Senior — Arts and Humanities ──────────────────────────────────
  { name: 'Literature in English', code: 'LIT', stage: 'senior', stream: 'arts' },
  { name: 'Government', code: 'GOV', stage: 'senior', stream: 'arts' },
  { name: 'History', code: 'HIS', stage: 'senior', stream: 'arts' },
  { name: 'Christian Religious Studies', code: 'CRS', stage: 'senior', stream: 'arts' },
  { name: 'Islamic Studies', code: 'IRS', stage: 'senior', stream: 'arts' },
  { name: 'Geography', code: 'GEO', stage: 'senior', stream: 'arts' },
  { name: 'Visual Arts', code: 'VAR', stage: 'senior', stream: 'arts' },
  { name: 'Music', code: 'MUS', stage: 'senior', stream: 'arts' },
  { name: 'French', code: 'FRN', stage: 'senior', stream: 'arts' },
  { name: 'Nigerian Language', code: 'NLG', stage: 'senior', stream: 'arts' },

  // ── Senior — Business and Commercial ───────────────────────────────
  { name: 'Financial Accounting', code: 'ACC', stage: 'senior', stream: 'business' },
  { name: 'Commerce', code: 'COM', stage: 'senior', stream: 'business' },
  { name: 'Economics', code: 'ECO', stage: 'senior', stream: 'business' },
  { name: 'Office Practice', code: 'OFP', stage: 'senior', stream: 'business' },
  { name: 'Marketing', code: 'MKT', stage: 'senior', stream: 'business' },
  { name: 'Insurance', code: 'INS', stage: 'senior', stream: 'business' },

  // ── Senior — available to any stream ───────────────────────────────
  { name: 'Computer Science', code: 'CMP', stage: 'senior' },
  { name: 'Data Processing', code: 'DPR', stage: 'senior' },
  { name: 'Food and Nutrition', code: 'FDN', stage: 'senior' },
  { name: 'Physical Education', code: 'PHE', stage: 'senior' },
];
