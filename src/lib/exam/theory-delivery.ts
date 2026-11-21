/**
 * How a paper that carries theory is put together for one candidate. Pure functions (no database), so the rules are
 * easy to prove.
 *
 *  - The OBJECTIVE part is drawn exactly as it always was (whole passages, shuffled if the paper shuffles).
 *  - EVERY theory question the paper carries goes to EVERY candidate, after the objective part, in the order the
 *    setter wrote them. Theory is not drawn and not shuffled: the plugin gives each student all of it, and a student
 *    who got a different theory question from a neighbour would be marked on a different paper.
 *  - The paper's own question count means OBJECTIVE questions only. It never shrinks because theory was added, so a
 *    paper that existed before theory delivery behaves identically.
 */
import { drawUnits, orderForDelivery, type PoolQuestion } from './passage-units';
import { drawTheory } from './theory-choice';

export type PaperPoolRow = PoolQuestion & { type: string; sequence: number; isCompulsory?: boolean };

export function isTheory(row: { type: string }): boolean { return row.type === 'theory'; }

/**
 * The order of questions one candidate sits: the objective draw, then theory in authored order.
 *
 * `theoryAnswerCount` is the teacher's choice of how many theory questions each student answers. 0 (the default, and
 * what every paper that existed before it means) gives every candidate ALL the theory. A number above 0 gives each
 * candidate that many: every compulsory question first, the rest made up by a random pick (see theory-choice.ts).
 */
export function candidateOrder(pool: PaperPoolRow[], objectiveTarget: number, shuffle: boolean, random: () => number = Math.random, theoryAnswerCount = 0): number[] {
  const objective = pool.filter((q) => !isTheory(q));
  const theory = pool.filter(isTheory).sort((a, b) => a.sequence - b.sequence || a.id - b.id);
  const drawn = drawUnits(orderForDelivery(objective, shuffle, random), objectiveTarget > 0 ? objectiveTarget : 0);
  const dealt = drawTheory(theory.map((q) => ({ id: q.id, isCompulsory: !!q.isCompulsory })), theoryAnswerCount, random);
  return [...drawn, ...dealt];
}

/** Ids of the theory questions inside an attempt's stored order (used to give each an answer row at submit). */
export function theoryIdsInOrder(order: number[], typeById: Map<number, string>): number[] {
  return order.filter((id) => typeById.get(id) === 'theory');
}

/**
 * Marks a paper carries per candidate, split in two. The objective part is the drawn questions; theory is every theory
 * question. Used to show the office what a paper is worth before it is published.
 */
export function paperWorth(pool: Array<{ type: string; marks: number }>, objectiveTarget: number): { objective: number; theory: number; theoryCount: number } {
  const objective = pool.filter((q) => !isTheory(q));
  const theory = pool.filter(isTheory);
  const avg = objective.length ? objective.reduce((s, q) => s + q.marks, 0) / objective.length : 0;
  const take = objectiveTarget > 0 ? Math.min(objectiveTarget, objective.length) : objective.length;
  return {
    objective: Math.round(avg * take * 100) / 100,
    theory: Math.round(theory.reduce((s, q) => s + q.marks, 0) * 100) / 100,
    theoryCount: theory.length,
  };
}

/**
 * Whether a paper's theory is answered ON PAPER. A set carries the flag (theory sets only); a paper is on paper only
 * when it carries theory AND every theory question comes from a flagged set. One ordinary theory set on the same paper
 * means students must type, so the whole paper falls back to typing: a half-and-half paper would have students typing
 * some answers and writing others, and the teacher marking two different ways on one script.
 */
export function paperIsOnPaper(theorySetFlags: boolean[]): boolean {
  return theorySetFlags.length > 0 && theorySetFlags.every(Boolean);
}

/** Only a theory set can carry the flag. An objective set asked to carry it is simply not on paper. */
export function setFlag(examType: string, requested: boolean): boolean {
  return examType === 'theory' && requested;
}

/** May a typed answer be stored for this question? Never for a theory question on an on-paper paper. */
export function typedAnswerRefused(paperOnPaper: boolean, questionType: string): boolean {
  return paperOnPaper && questionType === 'theory';
}
