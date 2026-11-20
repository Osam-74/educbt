/**
 * Comprehension passages are delivered as a UNIT: a candidate gets a passage with
 * ALL of its questions or none of it, never a passage with two of its four
 * questions. Pure functions only (no database), so the rule is easy to prove.
 */

export type PoolQuestion = {
  id: number;
  passageId: number | null;
  passagePosition: number;
  /** Counts toward the paper. A question that is not usable never reaches a candidate. */
  usable?: boolean;
};

export type Unit = { passageId: number | null; ids: number[] };

/** Group a pool into units: one per passage (ordered by reading position) and one per standalone question. */
export function toUnits(pool: PoolQuestion[]): Unit[] {
  const blocks = new Map<number, PoolQuestion[]>();
  const units: Unit[] = [];
  for (const q of pool) {
    if (q.passageId) {
      const b = blocks.get(q.passageId) ?? [];
      b.push(q);
      blocks.set(q.passageId, b);
    } else {
      units.push({ passageId: null, ids: [q.id] });
    }
  }
  for (const [passageId, qs] of blocks) {
    qs.sort((a, b) => a.passagePosition - b.passagePosition || a.id - b.id);
    units.push({ passageId, ids: qs.map((q) => q.id) });
  }
  return units;
}

/** Fisher-Yates over any list, with an injectable random for testing. */
export function shuffled<T>(items: T[], random: () => number = Math.random): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/**
 * Pick up to `target` questions without splitting a passage. Units are taken in
 * the given order; a unit that would overflow the target is skipped (a later,
 * smaller one may still fit). `target <= 0` means "everything".
 */
export function drawUnits(units: Unit[], target: number): number[] {
  if (target <= 0) return units.flatMap((u) => u.ids);
  const out: number[] = [];
  for (const u of units) {
    if (out.length + u.ids.length <= target) out.push(...u.ids);
    if (out.length === target) break;
  }
  return out;
}

/** Order for delivery: units shuffled (or kept), the questions inside a passage ALWAYS in reading order. */
export function orderForDelivery(pool: PoolQuestion[], shuffle: boolean, random: () => number = Math.random): Unit[] {
  const units = toUnits(pool);
  return shuffle ? shuffled(units, random) : units;
}

/**
 * The largest total at or below `target` that whole units can add up to (subset sum
 * over unit sizes). `target - best` is the shortfall: how many questions the
 * paper cannot reach without splitting a passage.
 */
export function bestReachable(units: Unit[], target: number): number {
  if (target <= 0) return 0;
  let reach = new Uint8Array(target + 1);
  reach[0] = 1;
  for (const u of units) {
    const size = u.ids.length;
    if (size > target) continue;
    const next = reach.slice();
    for (let s = 0; s + size <= target; s++) if (reach[s]) next[s + size] = 1;
    reach = next;
  }
  for (let t = target; t >= 0; t--) if (reach[t]) return t;
  return 0;
}

export type PassageWarning =
  | { kind: 'incomplete_passage'; passageId: number; unusable: number; total: number }
  | { kind: 'cannot_reach_target'; target: number; reachable: number };

/**
 * What a setter should be told before the paper goes out: passages that will
 * reach students with fewer questions than were written (some are unapproved
 * or have no correct answer), and a paper size that can only be met by splitting.
 */
export function passageWarnings(pool: PoolQuestion[], target: number): PassageWarning[] {
  const warnings: PassageWarning[] = [];
  const byPassage = new Map<number, PoolQuestion[]>();
  for (const q of pool) if (q.passageId) byPassage.set(q.passageId, [...(byPassage.get(q.passageId) ?? []), q]);
  for (const [passageId, qs] of byPassage) {
    const unusable = qs.filter((q) => q.usable === false).length;
    if (unusable > 0) warnings.push({ kind: 'incomplete_passage', passageId, unusable, total: qs.length });
  }
  if (target > 0) {
    const usable = pool.filter((q) => q.usable !== false);
    const reachable = bestReachable(toUnits(usable), target);
    const available = usable.length;
    if (reachable < Math.min(target, available)) warnings.push({ kind: 'cannot_reach_target', target, reachable });
  }
  return warnings;
}
