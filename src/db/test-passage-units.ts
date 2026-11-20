// Pure rules for whole-passage delivery. No database needed.
import { toUnits, drawUnits, orderForDelivery, bestReachable, passageWarnings, shuffled, type PoolQuestion } from '@/lib/exam/passage-units';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => { if (ok) { pass++; console.log('PASS  ' + name); } else { fail++; console.log('FAIL  ' + name + '  ' + detail); } };
const rng = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };

// passage 1 has 4 questions (positions out of order in the pool), passage 2 has 3, plus 5 loose questions
const pool: PoolQuestion[] = [
  { id: 13, passageId: 1, passagePosition: 3 }, { id: 11, passageId: 1, passagePosition: 1 }, { id: 10, passageId: 1, passagePosition: 0 }, { id: 12, passageId: 1, passagePosition: 2 },
  { id: 21, passageId: 2, passagePosition: 1 }, { id: 20, passageId: 2, passagePosition: 0 }, { id: 22, passageId: 2, passagePosition: 2 },
  ...[1, 2, 3, 4, 5].map((n) => ({ id: 100 + n, passageId: null, passagePosition: 0 })),
];

const units = toUnits(pool);
check('one unit per passage plus one per loose question', units.length === 2 + 5, String(units.length));
check('questions inside a passage are in reading order', JSON.stringify(units.find((u) => u.passageId === 1)!.ids) === '[10,11,12,13]');

// 3000 random draws of several sizes: a passage is NEVER partial
let split = 0, overTarget = 0;
for (const target of [3, 5, 6, 7, 8, 9, 10, 12]) {
  for (let s = 1; s <= 400; s++) {
    const picked = drawUnits(orderForDelivery(pool, true, rng(s * 7919 + target)), target);
    if (picked.length > target) overTarget++;
    for (const pid of [1, 2]) {
      const mine = pool.filter((q) => q.passageId === pid).map((q) => q.id);
      const got = mine.filter((id) => picked.includes(id)).length;
      if (got !== 0 && got !== mine.length) split++;
    }
  }
}
check('3200 shuffled draws never split a passage', split === 0, `${split} split`);
check('a draw never exceeds the paper size', overTarget === 0, `${overTarget} over`);
check('order inside a passage survives shuffling', (() => { const o = orderForDelivery(pool, true, rng(5)).find((u) => u.passageId === 1)!.ids; return JSON.stringify(o) === '[10,11,12,13]'; })());
check('target 0 means everything', drawUnits(units, 0).length === pool.length);
check('different seeds give different orders', JSON.stringify(shuffled([1, 2, 3, 4, 5, 6], rng(1))) !== JSON.stringify(shuffled([1, 2, 3, 4, 5, 6], rng(2))));

// shuffling really reorders units (so every student does not get the same passages), and a fixed order is kept when shuffling is off
const firstUnit = new Set<string>(); for (let s = 1; s <= 60; s++) firstUnit.add(JSON.stringify(orderForDelivery(pool, true, rng(s))[0]!.ids));
check('shuffling varies which unit comes first', firstUnit.size > 3, String(firstUnit.size));
check('with shuffling off the order is the pool order', JSON.stringify(orderForDelivery(pool, false).map((u) => u.passageId)) === JSON.stringify(toUnits(pool).map((u) => u.passageId)));

// reachable totals: units are 4, 3 and five 1s
check('reachable: 12 questions can be met exactly', bestReachable(units, 12) === 12);
check('reachable: nothing above the whole pool', bestReachable(units, 50) === 12);
check('reachable: a target of 2 is met by loose questions', bestReachable(units, 2) === 2);
const onlyBig = toUnits([{ id: 1, passageId: 9, passagePosition: 0 }, { id: 2, passageId: 9, passagePosition: 1 }, { id: 3, passageId: 9, passagePosition: 2 }]);
check('reachable: a 3-question passage cannot fill a paper of 2', bestReachable(onlyBig, 2) === 0);

// warnings
const flagged: PoolQuestion[] = pool.map((q) => (q.id === 12 ? { ...q, usable: false } : q));
const w = passageWarnings(flagged, 6);
check('warns when a passage will reach students with a question missing', w.some((x) => x.kind === 'incomplete_passage' && x.passageId === 1 && x.unusable === 1 && x.total === 4), JSON.stringify(w));
check('no warning for a complete pool that can meet its size', passageWarnings(pool, 7).length === 0, JSON.stringify(passageWarnings(pool, 7)));
check('warns when the paper size cannot be met without splitting', passageWarnings(onlyBig.flatMap((u) => u.ids.map((id, i) => ({ id, passageId: 9, passagePosition: i }))), 2).some((x) => x.kind === 'cannot_reach_target'));

console.log(fail ? `FAILED: ${pass} passed, ${fail} failed` : `OK: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
