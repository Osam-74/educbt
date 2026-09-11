import assert from 'node:assert/strict';
import { defaultConfig, parseAcademic, profileSchema, sessionSchema, termSchema, rangeSchema, suggestedRemark, componentStructure, examDefaultsSchema } from './validation';
import { reportGradingKey } from '@/lib/reports/summary';
let count = 0;
function check(name: string, fn: () => void) { fn(); count++; console.log('PASS  ' + name); }
const clone = () => structuredClone(defaultConfig);
check('default proposal satisfies existing result domain', () => assert(parseAcademic(clone())));
for (const [name, alter] of [
  ['non-100 total', (c: ReturnType<typeof clone>) => { c.assessmentComponents[0]!.maxScore = 30; }],
  ['two exams', (c: ReturnType<typeof clone>) => { c.assessmentComponents[0]!.isExam = true; }],
  ['no exam', (c: ReturnType<typeof clone>) => { c.assessmentComponents[1]!.isExam = false; }],
  ['duplicate keys', (c: ReturnType<typeof clone>) => { c.assessmentComponents[0]!.key = 'exam'; }],
  ['zero weight', (c: ReturnType<typeof clone>) => { c.assessmentComponents[0]!.maxScore = 0; }],
  ['overlapping thresholds', (c: ReturnType<typeof clone>) => { c.gradingScale.bands[0]!.min = 70; }],
  ['uncovered low scores', (c: ReturnType<typeof clone>) => { c.gradingScale.bands.pop(); }],
  ['duplicate grade', (c: ReturnType<typeof clone>) => { c.gradingScale.bands[0]!.grade = 'B2'; }],
  ['conflicting tiebreakers', (c: ReturnType<typeof clone>) => { c.rankingPolicy.tiebreakers = ['none', 'exam']; }],
  ['duplicate tiebreakers', (c: ReturnType<typeof clone>) => { c.rankingPolicy.tiebreakers = ['exam', 'exam']; }],
] as const) check(name + ' rejected', () => { const c = clone(); alter(c); assert.throws(() => parseAcademic(c)); });
check('label and display ordering do not change score structure', () => { const c = clone(); c.assessmentComponents[0]!.label = 'Homework'; c.assessmentComponents.reverse(); assert.equal(componentStructure(c.assessmentComponents), componentStructure(defaultConfig.assessmentComponents)); });
const profile = { name: 'School', address: '', phone: '', email: '', website: '', principalName: '' };
check('profile accepts missing optional contact details', () => assert(profileSchema.safeParse(profile).success));
check('school code cannot be submitted as editable', () => assert(!profileSchema.safeParse({ ...profile, code: 'CHANGED' }).success));
check('website cannot carry javascript', () => assert(!profileSchema.safeParse({ ...profile, website: 'javascript:alert(1)' }).success));
check('email validation', () => assert(!profileSchema.safeParse({ ...profile, email: 'invalid' }).success));
check('invalid calendar day rejected', () => assert(!sessionSchema.safeParse({ title: '2026/27', startsOn: '2026-02-30', endsOn: '', makeCurrent: false }).success));
check('reversed dates rejected', () => assert(!sessionSchema.safeParse({ title: '2026/27', startsOn: '2026-09-01', endsOn: '2026-07-01', makeCurrent: false }).success));
check('optional calendar dates stay optional', () => assert(sessionSchema.safeParse({ title: '2026/27', startsOn: '', endsOn: '', makeCurrent: false }).success));
check('term needs valid session', () => assert(!termSchema.safeParse({ sessionId: 0, title: 'Term', position: 1, startsOn: '', endsOn: '' }).success));
check('remark ranges cover zero', () => assert(!rangeSchema.safeParse([{ min: 50, remark: 'Good' }]).success));
check('remark duplicate threshold rejected', () => assert(!rangeSchema.safeParse([{ min: 0, remark: 'A' }, { min: 0, remark: 'B' }]).success));
check('empty ranges disable automatic suggestions', () => assert.equal(suggestedRemark([], 60), null));
check('decimal average selects correct half-open range', () => assert.equal(suggestedRemark([{ min: 0, remark: 'Keep trying' }, { min: 40, remark: 'Pass' }], 39.99), 'Keep trying'));
check('true zero selects lowest remark', () => assert.equal(suggestedRemark([{ min: 0, remark: 'Keep trying' }], 0), 'Keep trying'));
check('exam defaults use engine duration bounds', () => { assert(examDefaultsSchema.safeParse({ durationMinutes: 90 }).success); assert(!examDefaultsSchema.safeParse({ durationMinutes: 301 }).success); });
check('historical school key uses stored snapshot', () => { const scale = { id: 'school-1', version: 2, name: 'School scale', bands: [{ min: 0, grade: 'P', remark: 'Pass' }] }; assert(reportGradingKey([{ scaleId: scale.id, scaleVersion: 2 }], [scale]).includes('P: 0–100')); });
console.log(`${count} settings validation checks passed`);
