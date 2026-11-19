/** npx tsx src/lib/calendar/glance.test.ts */
import assert from 'node:assert/strict';
import { instructionalLabel as f } from './glance';
let n = 0; const check = (name: string, fn: () => void) => { fn(); n++; console.log('PASS  ' + name); };
const base = { haveTimetable: true, teachingToday: true, weekday: 3, lessonCount: 0 };
check('no timetable at all says nothing (the panel hides itself)', () => assert.equal(f({ ...base, haveTimetable: false }), ''));
check('lessons to show means no sentence', () => assert.equal(f({ ...base, lessonCount: 3 }), ''));
check('a weekday with a timetable but nothing for this person', () => assert.equal(f(base), 'No lessons scheduled for you today.'));
check('Saturday and Sunday say it is the weekend, not a holiday', () => { assert.match(f({ ...base, weekday: 6, teachingToday: false }), /weekend/); assert.match(f({ ...base, weekday: 7, teachingToday: false }), /weekend/); });
check('a weekday that is not a teaching day says break or holiday', () => assert.match(f({ ...base, teachingToday: false }), /break or holiday/));
check('lessons win over everything: a holiday flag with lessons listed says nothing', () => assert.equal(f({ ...base, teachingToday: false, lessonCount: 2 }), ''));
console.log(`\n${n} checks passed.`);
