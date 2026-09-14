import assert from 'node:assert/strict';
import { authoringConfig, authoringScopeSchema, collectionIsOpen, collectionSchema, validateQuestion } from './authoring-validation';
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
console.log(`${count} authoring validation checks passed`);
