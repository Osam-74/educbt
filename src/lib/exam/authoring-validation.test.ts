import assert from 'node:assert/strict';
import { authoringConfig, authoringScopeSchema, collectionIsOpen, collectionSchema, validateQuestion, validateQuestionParts } from './authoring-validation';
let count = 0;
function check(name: string, run: () => void) { run(); console.log('PASS  ' + name); count++; }
const question = { text: 'Which number is even?', marks: 1, options: [{ text: 'Two', isCorrect: true }, { text: 'Three', isCorrect: false }] };
check('valid objective question', () => assert.equal(validateQuestion(question, 'objective').options?.length, 2));
for (const [name, input] of [
  ['empty question', { ...question, text: '   ' }], ['zero marks', { ...question, marks: 0 }],
  ['negative marks', { ...question, marks: -1 }], ['nonfinite marks', { ...question, marks: NaN }],
  ['fractional precision', { ...question, marks: 1.001 }],
  ['two correct options', { ...question, options: question.options.map(o => ({ ...o, isCorrect: true })) }],
  ['no correct option', { ...question, options: question.options.map(o => ({ ...o, isCorrect: false })) }],
  ['duplicate options', { ...question, options: [{ text: 'Two', isCorrect: true }, { text: ' two ', isCorrect: false }] }],
  ['one nonempty option', { ...question, options: [{ text: 'Two', isCorrect: true }, { text: ' ', isCorrect: false }] }],
] as const) check(name + ' is rejected', () => assert.throws(() => validateQuestion(input, 'objective')));
check('theory accepts fractional marks without options', () => assert.equal(validateQuestion({ text: 'Explain the water cycle.', marks: 2.5 }, 'theory').marks, 2.5));
check('blank correct option does not make question valid', () => assert.throws(() => validateQuestion({ ...question, options: [{ text: '', isCorrect: true }, { text: 'A', isCorrect: false }, { text: 'B', isCorrect: false }] }, 'objective')));
const series = { seriesType: 'examination', status: 'draft', questionsOpenFrom: new Date('2026-09-01T00:00:00Z'), questionsOpenTo: new Date('2026-09-10T00:00:00Z') };
check('opening instant included', () => assert(collectionIsOpen(series, series.questionsOpenFrom)));
check('closing instant excluded', () => assert(!collectionIsOpen(series, series.questionsOpenTo)));
check('before opening rejected', () => assert(!collectionIsOpen(series, new Date('2026-08-31'))));
check('missing dates fail closed', () => assert(!collectionIsOpen({ ...series, questionsOpenTo: null })));
check('practice does not require dates', () => assert(collectionIsOpen({ ...series, seriesType: 'practice', questionsOpenFrom: null, questionsOpenTo: null })));
check('published practice remains independent of formal collection', () => assert(collectionIsOpen({ ...series, seriesType: 'practice', status: 'published', questionsOpenFrom: null, questionsOpenTo: null })));
for (const status of ['closed', 'cancelled', 'published', 'composed']) check(status + ' blocks collection', () => assert(!collectionIsOpen({ ...series, status }, series.questionsOpenFrom)));
check('default quotas are legacy 20/4 with closed window', () => assert.deepEqual(authoringConfig({}), { objective: 20, theory: 4, seriesId: null }));
check('configured quotas retained', () => assert.equal(authoringConfig({ questionBank: { objective: 30, theory: 6, seriesId: 5 } }).objective, 30));
check('invalid quota rejected', () => assert.throws(() => collectionSchema.parse({ objective: -1, theory: 4, seriesId: null })));
check('malformed configuration fails closed', () => assert.equal(authoringConfig({ questionBank: { seriesId: 'invalid' } }).seriesId, null));
check('foreign/nonpositive scope ids rejected before query', () => assert.throws(() => authoringScopeSchema.parse({ sessionId: 0 })));
// ── Theory question parts (plugin parity) ───────────────────────────────────
const parts = [{ label: 'a', text: 'Define osmosis.', marks: 2 }, { label: 'b', text: 'Give one example in plants.', marks: 3 }];
check('parts that add up to the question are accepted as given', () => assert.deepEqual(validateQuestionParts(parts, 5, 'theory'), parts));
check('no parts means no parts, so a question behaves exactly as before', () => { assert.deepEqual(validateQuestionParts(undefined, 5, 'theory'), []); assert.deepEqual(validateQuestionParts(null, 5, 'objective'), []); assert.deepEqual(validateQuestionParts([], 5, 'objective'), []); });
check('parts that add up to less are refused with the real numbers', () => assert.throws(() => validateQuestionParts([parts[0]], 5, 'theory'), /add up to 2 but the question is worth 5/));
check('parts that add up to more are refused', () => assert.throws(() => validateQuestionParts([{ ...parts[0]!, marks: 4 }, parts[1]!], 5, 'theory'), /add up to 7/));
check('decimal marks that drift in floating point still add up (0.1 + 0.2 against 0.3)', () => assert.equal(validateQuestionParts([{ label: 'a', text: 'x', marks: 0.1 }, { label: 'b', text: 'y', marks: 0.2 }], 0.3, 'theory').length, 2));
check('a real shortfall of one cent is still refused', () => assert.throws(() => validateQuestionParts([{ label: 'a', text: 'x', marks: 0.1 }, { label: 'b', text: 'y', marks: 0.19 }], 0.3, 'theory'), /add up to 0.29/));
check('duplicate labels are refused, case-insensitively', () => assert.throws(() => validateQuestionParts([parts[0]!, { ...parts[1]!, label: 'A' }], 5, 'theory'), /different label/));
check('objective questions cannot carry parts', () => assert.throws(() => validateQuestionParts(parts, 5, 'objective'), /Only theory/));
check('a part with no text, no label, zero or negative marks is refused', () => { for (const bad of [{ ...parts[0]!, text: ' ' }, { ...parts[0]!, label: '' }, { ...parts[0]!, marks: 0 }, { ...parts[0]!, marks: -1 }]) assert.throws(() => validateQuestionParts([bad, parts[1]!], 5, 'theory')); });
check('more than ten parts are refused', () => assert.throws(() => validateQuestionParts(Array.from({ length: 11 }, (_, i) => ({ label: 'p' + i, text: 't', marks: 1 })), 11, 'theory'), /at most 10/));
check('part marks with three decimals are refused', () => assert.throws(() => validateQuestionParts([{ label: 'a', text: 'x', marks: 1.005 }], 1.005, 'theory')));

// WAEC eligibility comes from the level's stage setting, never from guessing at its name.
import { waecEligibility } from './authoring-validation';
check('a senior level is eligible whatever it is called', () => assert.equal(waecEligibility({ subject: 'English Language', stage: 'senior', delivery: 'cbt' }).eligible, true));
check('a level spanning junior and senior counts as senior', () => assert.equal(waecEligibility({ subject: 'English', stage: 'both', delivery: 'cbt' }).eligible, true));
check('a junior level is not eligible, even if its name looks like SS1', () => assert.equal(waecEligibility({ subject: 'English', stage: 'junior', delivery: 'cbt' }).eligible, false));
check('only English is eligible', () => assert.equal(waecEligibility({ subject: 'Mathematics', stage: 'senior', delivery: 'cbt' }).eligible, false));
check('English variants are all recognised', () => { for (const n of ['English', 'english language', 'ENGLISH STUDIES', 'Use of English']) assert.equal(waecEligibility({ subject: n, stage: 'senior', delivery: 'cbt' }).eligible, true, n); });
check('written delivery is not eligible', () => assert.equal(waecEligibility({ subject: 'English', stage: 'senior', delivery: 'written' }).eligible, false));
check('nothing chosen yet is not eligible, and the reason is about choosing, not about English', () => { const r = waecEligibility({ subject: '', stage: null, delivery: 'cbt' }); assert.equal(r.eligible, false); assert.match(r.reason!, /Choose a subject/); });
check('every refusal says why, so the page can explain a hidden option', () => {
  assert.match(waecEligibility({ subject: 'Mathematics', stage: 'senior', delivery: 'cbt' }).reason!, /English/);
  assert.match(waecEligibility({ subject: 'English', stage: 'junior', delivery: 'cbt' }).reason!, /senior/i);
  assert.match(waecEligibility({ subject: 'English', stage: 'senior', delivery: 'written' }).reason!, /computer|CBT/i);
  assert.equal(waecEligibility({ subject: 'English', stage: 'senior', delivery: 'cbt' }).reason, null);
});

console.log(`${count} authoring validation checks passed`);
