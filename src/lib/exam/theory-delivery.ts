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

export type PaperPoolRow = PoolQuestion & { type: string; sequence: number };

export function isTheory(row: { type: string }): boolean { return row.type === 'theory'; }

/** The order of questions one candidate sits: the objective draw, then all theory in authored order. */
export function candidateOrder(pool: PaperPoolRow[], objectiveTarget: number, shuffle: boolean, random: () => number = Math.random): number[] {
  const objective = pool.filter((q) => !isTheory(q));
  const theory = pool.filter(isTheory).sort((a, b) => a.sequence - b.sequence || a.id - b.id);
  const drawn = drawUnits(orderForDelivery(objective, shuffle, random), objectiveTarget > 0 ? objectiveTarget : 0);
  return [...drawn, ...theory.map((q) => q.id)];
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
