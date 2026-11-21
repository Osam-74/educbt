/**
 * The WAEC English Language structure (WASSCE, Nigeria): three papers and fourteen sections.
 *
 * The section KEYS are the contract with the WordPress plugin. A question stores "paper2:comprehension", and the
 * same text means the same section in both products, so a school's data moves between them without translation.
 * Pure data and functions only (no database), so the rules are easy to prove.
 */

export type WaecSection = {
  /** Stored on the question: "<paper>:<section>", e.g. "paper1:antonyms". */
  key: string;
  paperKey: 'paper1' | 'paper2' | 'paper3';
  paper: string;
  label: string;
  count: number;
  marks: number;
  guide: string;
  /** Questions in this section are written about a passage the teacher supplies. */
  needsPassage: boolean;
  examType: 'objective' | 'theory';
};

const P1 = 'Paper 1 — Objective Test', P2 = 'Paper 2 — Essay, Comprehension and Summary', P3 = 'Paper 3 — Test of Orals';

export const WAEC_SECTIONS: readonly WaecSection[] = [
  { key: 'paper1:antonyms', paperKey: 'paper1', paper: P1, label: 'Section 1 — Antonyms', count: 10, marks: 5, needsPassage: false, examType: 'objective', guide: 'A sentence with an underlined word. Choose the option most nearly opposite in meaning.' },
  { key: 'paper1:synonyms', paperKey: 'paper1', paper: P1, label: 'Section 2 — Synonyms', count: 10, marks: 5, needsPassage: false, examType: 'objective', guide: 'A sentence with an underlined word. Choose the option nearest in meaning.' },
  { key: 'paper1:idioms', paperKey: 'paper1', paper: P1, label: 'Section 3 — Idioms and Interpretations', count: 10, marks: 5, needsPassage: false, examType: 'objective', guide: 'A sentence containing an idiom or complex phrase. Choose the option that best explains its meaning.' },
  { key: 'paper1:grammar', paperKey: 'paper1', paper: P1, label: 'Section 4 — Grammar and Structure', count: 40, marks: 20, needsPassage: false, examType: 'objective', guide: 'Fill-in-the-blank questions testing concord, tenses, prepositions, phrasal verbs, and clauses.' },
  { key: 'paper1:cloze', paperKey: 'paper1', paper: P1, label: 'Section 5 — Cloze Passage', count: 10, marks: 5, needsPassage: true, examType: 'objective', guide: 'A continuous prose passage with numbered gaps, testing contextual vocabulary and structural flow.' },
  { key: 'paper2:essay', paperKey: 'paper2', paper: P2, label: 'Section A — Essay Writing', count: 5, marks: 50, needsPassage: false, examType: 'theory', guide: 'Five topics across formal letter, informal letter, article for publication, debate or speech, and story or narrative. The candidate answers one.' },
  { key: 'paper2:comprehension', paperKey: 'paper2', paper: P2, label: 'Section B — Comprehension', count: 1, marks: 20, needsPassage: true, examType: 'theory', guide: 'One prose passage with 7 to 9 questions: literal, inferential, figure of speech, grammatical name and function, and vocabulary replacement.' },
  { key: 'paper2:summary', paperKey: 'paper2', paper: P2, label: 'Section C — Summary', count: 1, marks: 30, needsPassage: true, examType: 'theory', guide: "One prose passage with 2 to 3 questions requiring extraction of specific points in the candidate's own words." },
  { key: 'paper3:vowels', paperKey: 'paper3', paper: P3, label: 'Section 1 — Vowels', count: 15, marks: 7.5, needsPassage: false, examType: 'objective', guide: 'Identify words with the same vowel sound (monophthongs and diphthongs) as the underlined letter(s).' },
  { key: 'paper3:consonants', paperKey: 'paper3', paper: P3, label: 'Section 2 — Consonants', count: 15, marks: 7.5, needsPassage: false, examType: 'objective', guide: 'Identify words with the same consonant sound as the underlined letter(s).' },
  { key: 'paper3:rhymes', paperKey: 'paper3', paper: P3, label: 'Section 3 — Rhymes', count: 10, marks: 5, needsPassage: false, examType: 'objective', guide: 'Choose the word that rhymes perfectly with the given word.' },
  { key: 'paper3:word_stress', paperKey: 'paper3', paper: P3, label: 'Section 4 — Word Stress', count: 10, marks: 5, needsPassage: false, examType: 'objective', guide: 'Identify which syllable in a multisyllabic word carries the primary stress.' },
  { key: 'paper3:emphatic_stress', paperKey: 'paper3', paper: P3, label: 'Section 5 — Emphatic Stress', count: 5, marks: 2.5, needsPassage: false, examType: 'objective', guide: 'A sentence with one word in CAPITAL LETTERS. Choose the question that prompts that exact sentence as an answer.' },
  { key: 'paper3:phonetic_symbols', paperKey: 'paper3', paper: P3, label: 'Section 6 — Phonetic Symbols', count: 5, marks: 2.5, needsPassage: false, examType: 'objective', guide: 'Identify the word that matches a specific phonetic symbol provided.' },
];

const BY_KEY = new Map(WAEC_SECTIONS.map((s) => [s.key, s]));

export function waecSection(key: string): WaecSection | null { return BY_KEY.get(key) ?? null; }

/** The sections a teacher may choose for a set of this exam type (objective questions or theory questions). */
export function sectionsFor(examType: 'objective' | 'theory'): WaecSection[] { return WAEC_SECTIONS.filter((s) => s.examType === examType); }

/**
 * Is this the value a question's section may hold?
 *  - '' (no section) is always allowed: an ordinary question, or a WAEC one not yet placed.
 *  - a WAEC section key is allowed only on a WAEC-structured set, and only on the exam type that section belongs to.
 */
export function sectionProblem(section: string, set: { waecMode: boolean; examType: 'objective' | 'theory' }): string | null {
  const key = section.trim();
  if (key === '') return null;
  if (!set.waecMode) return 'Sections apply only to a WAEC-structured set.';
  const found = BY_KEY.get(key);
  if (!found) return `"${key}" is not a section of the WAEC English paper.`;
  if (found.examType !== set.examType) return `${found.label} belongs to the ${found.examType} questions, not ${set.examType}.`;
  return null;
}

/** How far along a set is, section by section, from the sections its questions carry. */
export function sectionProgress(examType: 'objective' | 'theory', questions: Array<{ section: string }>) {
  const counts = new Map<string, number>();
  for (const q of questions) counts.set(q.section, (counts.get(q.section) ?? 0) + 1);
  const rows = sectionsFor(examType).map((s) => ({ ...s, written: counts.get(s.key) ?? 0, done: (counts.get(s.key) ?? 0) >= s.count }));
  const unplaced = questions.filter((q) => !BY_KEY.has(q.section)).length;
  return { rows, unplaced };
}

/**
 * May this question's section still be changed?
 * Until the question is submitted AND approved. Once the exam office has approved it, the section is fixed: other
 * questions and the paper's structure now depend on it. A question that was sent back for revision is open again.
 */
export function sectionLocked(q: { approvalStatus: 'pending' | 'approved' | 'revision' }, set: { status: string }): { locked: boolean; reason: string | null } {
  if (set.status !== 'draft' && set.status !== 'returned') return { locked: true, reason: 'This set has been handed in. Ask the exam office to send it back to change a section.' };
  if (q.approvalStatus === 'approved') return { locked: true, reason: 'This question has been approved, so its section can no longer be changed.' };
  return { locked: false, reason: null };
}
