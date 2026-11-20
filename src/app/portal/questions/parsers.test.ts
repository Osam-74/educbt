/**
 * The question importers, with the cases real files produce: passages with paragraph breaks inside a quoted
 * cell, Excel's byte-order mark, Windows line endings, doubled quotes, passage rows, and references that lead nowhere.
 *   npx tsx src/app/portal/questions/parsers.test.ts
 */
import assert from 'node:assert/strict';
import { parseCSV, parseCSVRecords, CSV_TEMPLATE } from './parsers';

let n = 0;
function check(name: string, fn: () => void) { fn(); n++; console.log('PASS  ' + name); }

const H = 'question,option_a,option_b,option_c,option_d,correct_option,marks,passage_ref,passage_title,passage_instructions,passage_text';
const PASSAGE = '"The market opens at dawn.\nTraders arrange their goods.\n\nThen the customers come."';
const file = [
  H,
  `,,,,,,,P1,The Village Market,Read it and answer 1 to 2.,${PASSAGE}`,
  'When does the market open?,At dawn,At noon,At night,Never,A,1,P1,,,',
  'Who arrives after the traders?,Customers,Nobody,Police,Birds,A,1,P1,,,',
  'What is 2+2?,3,4,5,6,B,2,,,,',
].join('\n');

check('a passage with line breaks inside a quoted cell stays in ONE piece', () => {
  const out = parseCSV(file, false, 1);
  assert.equal(out.passages.length, 1);
  assert.equal(out.passages[0]!.body, 'The market opens at dawn.\nTraders arrange their goods.\n\nThen the customers come.');
});
check('the old behaviour would have cut it: the reader returns 5 records, not 8 lines', () => {
  assert.equal(parseCSVRecords(file).length, 5);
});
check('the passage row is not treated as a question', () => {
  const out = parseCSV(file, false, 1);
  assert.equal(out.rows.length, 3);
  assert.ok(out.rows.every((r) => r.text !== ''));
});
check('the passage keeps its title and instruction', () => {
  const d = parseCSV(file, false, 1).passages[0]!;
  assert.equal(d.title, 'The Village Market'); assert.equal(d.instructions, 'Read it and answer 1 to 2.'); assert.equal(d.ref, 'P1');
});
check('questions that share a ref belong to that passage, others to none', () => {
  const rows = parseCSV(file, false, 1).rows;
  assert.deepEqual(rows.map((r) => r.passageRef ?? null), ['P1', 'P1', null]);
  assert.ok(rows.every((r) => r.status === 'valid'), JSON.stringify(rows.map((r) => r.errors)));
});
check('refs match whatever the capital letters', () => {
  const f = file.replace(',P1,The Village', ',p1,The Village');
  const rows = parseCSV(f, false, 1).rows;
  assert.ok(rows.slice(0, 2).every((r) => r.status === 'valid'));
});
check('a ref that leads to no passage is an ERROR, never a silent import without its passage', () => {
  const f = [H, 'Orphan question?,A,B,C,D,A,1,P9,,,'].join('\n');
  const r = parseCSV(f, false, 1).rows[0]!;
  assert.equal(r.status, 'error'); assert.match(r.errors.join(' '), /passage_ref "P9" has no passage/);
});
check('a ref can name a passage the school already has, by exact title', () => {
  const f = [H, 'Orphan question?,A,B,C,D,A,1,the village market,,,'].join('\n');
  const r = parseCSV(f, false, 1, [{ id: 42, title: 'The Village Market' }]).rows[0]!;
  assert.equal(r.status, 'valid'); assert.equal(r.passageExistingId, 42);
});
check('Excel\'s byte-order mark and Windows line endings do not break the header or the rows', () => {
  const out = parseCSV('\uFEFF' + file.replace(/\n/g, '\r\n'), false, 1);
  assert.equal(out.rows.length, 3);
  // a Windows file must not leave stray carriage returns in the passage the students read
  assert.equal(out.passages[0]!.body, 'The market opens at dawn.\nTraders arrange their goods.\n\nThen the customers come.');
  assert.equal(out.rows[0]!.text, 'When does the market open?');
});
check('a doubled quote inside a quoted cell is one literal quote', () => {
  const f = [H, '"She said ""hello"" twice",A,B,C,D,A,1,,,,'].join('\n');
  assert.equal(parseCSV(f, false, 1).rows[0]!.text, 'She said "hello" twice');
});
check('a comma inside a quoted cell does not split it', () => {
  const f = [H, '"Bread, butter, jam?",A,B,C,D,A,1,,,,'].join('\n');
  assert.equal(parseCSV(f, false, 1).rows[0]!.text, 'Bread, butter, jam?');
});
check('a file with no passage columns at all imports exactly as before', () => {
  const f = ['question,option_a,option_b,option_c,option_d,correct_option,marks', 'What is 2+2?,3,4,5,6,B,2'].join('\n');
  const out = parseCSV(f, false, 1);
  assert.equal(out.rows.length, 1); assert.equal(out.passages.length, 0); assert.equal(out.rows[0]!.status, 'valid');
});
check('blank rows between records are skipped', () => {
  const f = [H, '', 'Q?,A,B,C,D,A,1,,,,', '', ''].join('\n');
  assert.equal(parseCSV(f, false, 1).rows.length, 1);
});
check('a file ending without a final line break still reads its last row', () => {
  const f = [H, 'Q one?,A,B,C,D,A,1,,,,', 'Q two?,A,B,C,D,B,1,,,,'].join('\n');
  assert.equal(parseCSV(f, false, 1).rows.length, 2);
});
check('theory CSVs are untouched by passage handling', () => {
  const f = ['question,marks,marking_guide', '"Explain photosynthesis",10,"Light to energy"'].join('\n');
  const out = parseCSV(f, true, 1);
  assert.equal(out.rows.length, 1); assert.equal(out.rows[0]!.marks, 10); assert.equal(out.passages.length, 0);
});
check('the downloadable template parses cleanly and contains one passage with its question', () => {
  const out = parseCSV(CSV_TEMPLATE.objective, false, 1);
  assert.equal(out.passages.length, 1); assert.equal(out.rows.length, 3);
  assert.ok(out.rows.every((r) => r.status === 'valid'), JSON.stringify(out.rows.map((r) => r.errors)));
  assert.equal(out.rows[2]!.passageRef, 'P1');
});
check('a passage row with no text is not a passage definition', () => {
  const f = [H, ',,,,,,,P1,Title,Instruction,'].join('\n');
  const out = parseCSV(f, false, 1);
  assert.equal(out.passages.length, 0);
});
check('a passage defined AFTER the questions that use it still links', () => {
  const f = [H, 'Q?,A,B,C,D,A,1,P1,,,', `,,,,,,,P1,Late,,"Text that arrives later in the file."`].join('\n');
  const out = parseCSV(f, false, 1);
  assert.equal(out.rows[0]!.status, 'valid'); assert.equal(out.passages.length, 1);
});
console.log(`\nOK: ${n} passed, 0 failed`);
