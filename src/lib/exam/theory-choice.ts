/**
 * The teacher decides how many theory questions each student answers, and which ones every student must get.
 * Pure functions (no database), so the rules are easy to prove and match the WordPress plugin rule for rule.
 *
 *  - answerCount 0 means "every student gets every theory question" (what the platform always did, and what every
 *    existing set and paper still means). A number N above 0 means each student gets N.
 *  - compulsory: a question the teacher ticked. Every student gets it, whatever the draw.
 *
 * Compulsory always wins. If a teacher ticks more questions than the number each student answers, every student still
 * gets all of the ticked ones, and the teacher is told so rather than having a tick ignored.
 */

/** What a teacher typed for "how many does each student answer", as a safe whole number. Blank or nonsense = 0 (all). */
export function normaliseAnswerCount(raw: unknown): number {
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t === '' || !/^\d+$/.test(t)) return 0;
    raw = t;
  }
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return 0;
  return n > 0 ? Math.min(n, 1000) : 0;
}

/**
 * Whether a set may be handed in with this choice. Returns a plain-words problem, or '' when it is fine.
 * The only refusal: students are asked to answer more theory questions than the teacher wrote.
 */
export function answerCountProblem(answerCount: number, written: number): string {
  if (answerCount <= 0) return '';
  if (answerCount > written) {
    return `You chose that each student answers ${answerCount} theory question${answerCount === 1 ? '' : 's'}, but only ${written} ${written === 1 ? 'is' : 'are'} written. Write more questions, or lower the number.`;
  }
  return '';
}

/** A note (not a refusal) for when the ticks outnumber the answers each student gives. */
export function compulsoryNotice(answerCount: number, compulsory: number): string {
  if (answerCount > 0 && compulsory > answerCount) {
    return `${compulsory} questions are ticked compulsory but each student answers ${answerCount}. Every student will get all ${compulsory} compulsory questions, so they will answer ${compulsory}.`;
  }
  return '';
}

/** How many theory questions one student receives. */
export function perStudent(answerCount: number, available: number, compulsory: number): number {
  if (answerCount <= 0 || answerCount >= available) return available;
  return Math.max(answerCount, Math.min(compulsory, available));
}

export type TheoryRow = { id: number; isCompulsory: boolean };

/**
 * Pick one student's theory questions, keeping the teacher's order. Every compulsory question is always included; the
 * remaining places are filled by a random draw from the others; the result is put back in the order the teacher wrote
 * them (theory is never shuffled), with only the chosen ones present.
 *
 * `rows` must already be in authored order. `random` is a test hook.
 */
export function drawTheory(rows: TheoryRow[], answerCount: number, random: () => number = Math.random): number[] {
  const ids = rows.map((r) => r.id);
  const compulsory = rows.filter((r) => r.isCompulsory).length;
  const take = perStudent(answerCount, ids.length, compulsory);
  if (take >= ids.length) return ids;

  const chosen = new Set(rows.filter((r) => r.isCompulsory).map((r) => r.id));
  const others = rows.filter((r) => !r.isCompulsory).map((r) => r.id);
  const need = take - chosen.size;
  if (need > 0 && others.length > 0) {
    // Fisher-Yates, so every non-compulsory question has the same chance.
    for (let i = others.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [others[i], others[j]] = [others[j]!, others[i]!];
    }
    for (const id of others.slice(0, need)) chosen.add(id);
  }
  return ids.filter((id) => chosen.has(id));
}

/**
 * The questions a student is expected to answer: only those in their own stored order. Used so a result is judged on
 * what the student was dealt, never on a theory question they were not given.
 */
export function dealtTheory(order: number[], theoryIds: Set<number>): number[] {
  return order.filter((id) => theoryIds.has(id));
}
