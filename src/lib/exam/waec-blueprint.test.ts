import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WAEC_SECTIONS, sectionsFor, waecSection, sectionProblem, sectionProgress } from './waec-blueprint';

let count = 0;
const check = (name: string, fn: () => void) => { fn(); count++; console.log('PASS  ' + name); };

check('there are 3 papers and 14 sections', () => { assert.equal(WAEC_SECTIONS.length, 14); assert.deepEqual([...new Set(WAEC_SECTIONS.map((s) => s.paperKey))], ['paper1', 'paper2', 'paper3']); });
check('every key is unique and follows paper:section', () => { assert.equal(new Set(WAEC_SECTIONS.map((s) => s.key)).size, 14); for (const s of WAEC_SECTIONS) assert.match(s.key, /^paper[123]:[a-z_]+$/); });
check('the paper totals are the WASSCE ones: 40, 100 and 30 marks (170 in all)', () => {
  const total = (p: string) => WAEC_SECTIONS.filter((s) => s.paperKey === p).reduce((n, s) => n + s.marks, 0);
  assert.equal(total('paper1'), 40); assert.equal(total('paper2'), 100); assert.equal(total('paper3'), 30);
});
check('paper 1 has 80 questions and paper 3 has 60', () => {
  const n = (p: string) => WAEC_SECTIONS.filter((s) => s.paperKey === p).reduce((a, s) => a + s.count, 0);
  assert.equal(n('paper1'), 80); assert.equal(n('paper3'), 60);
});
check('paper 2 is theory; papers 1 and 3 are objective', () => {
  for (const s of WAEC_SECTIONS) assert.equal(s.examType, s.paperKey === 'paper2' ? 'theory' : 'objective');
});
check('the passage-based sections are cloze, comprehension and summary, and no others', () => {
  assert.deepEqual(WAEC_SECTIONS.filter((s) => s.needsPassage).map((s) => s.key).sort(), ['paper1:cloze', 'paper2:comprehension', 'paper2:summary']);
});
check('sectionsFor splits objective (11) from theory (3)', () => { assert.equal(sectionsFor('objective').length, 11); assert.equal(sectionsFor('theory').length, 3); });
check('waecSection finds a real key and returns null for a made-up one', () => { assert.equal(waecSection('paper2:comprehension')!.label, 'Section B — Comprehension'); assert.equal(waecSection('paper9:nope'), null); });

check('no section is always fine', () => { for (const w of [true, false]) for (const t of ['objective', 'theory'] as const) assert.equal(sectionProblem('', { waecMode: w, examType: t }), null); });
check('a real section on a WAEC set of the right type is fine', () => { assert.equal(sectionProblem('paper1:grammar', { waecMode: true, examType: 'objective' }), null); assert.equal(sectionProblem('paper2:essay', { waecMode: true, examType: 'theory' }), null); });
check('a section on an ordinary set is refused', () => assert.match(sectionProblem('paper1:grammar', { waecMode: false, examType: 'objective' })!, /WAEC-structured/));
check('an unknown section is refused by name', () => assert.match(sectionProblem('paper1:typo', { waecMode: true, examType: 'objective' })!, /not a section/));
check('an objective section on a theory set (and the reverse) is refused', () => {
  assert.match(sectionProblem('paper1:grammar', { waecMode: true, examType: 'theory' })!, /objective questions/);
  assert.match(sectionProblem('paper2:essay', { waecMode: true, examType: 'objective' })!, /theory questions/);
});
check('surrounding spaces in a section are ignored', () => assert.equal(sectionProblem('  paper1:cloze ', { waecMode: true, examType: 'objective' }), null));

check('progress counts questions per section and reports the unplaced ones', () => {
  const p = sectionProgress('objective', [{ section: 'paper1:antonyms' }, { section: 'paper1:antonyms' }, { section: 'paper1:cloze' }, { section: '' }, { section: '0' }]);
  assert.equal(p.rows.find((r) => r.key === 'paper1:antonyms')!.written, 2);
  assert.equal(p.rows.find((r) => r.key === 'paper1:cloze')!.written, 1);
  assert.equal(p.rows.find((r) => r.key === 'paper1:grammar')!.written, 0);
  assert.equal(p.unplaced, 2, 'a blank section and the old "0" value are both unplaced');
});
check('a section is done only when its full count is written', () => {
  const ten = Array.from({ length: 10 }, () => ({ section: 'paper1:synonyms' }));
  assert.equal(sectionProgress('objective', ten).rows.find((r) => r.key === 'paper1:synonyms')!.done, true);
  assert.equal(sectionProgress('objective', ten.slice(1)).rows.find((r) => r.key === 'paper1:synonyms')!.done, false);
});

// The contract with the WordPress plugin: compare against its real source when it is checked out next to this repo.
const plugin = join(process.cwd(), '..', 'plugin', 'cbt', 'includes', 'Services', 'WaecBlueprintService.php');
if (existsSync(plugin)) {
  const php = readFileSync(plugin, 'utf8');
  check('PLUGIN CONTRACT: every section key, count and marks matches the plugin exactly', () => {
    const theirs: Array<{ key: string; count: number; marks: number }> = [];
    // Split the PHP at each paper heading, then read that paper's sections, so a section is credited to ITS paper.
    const heads = [...php.matchAll(/'(paper\d)'\s*=>\s*\[/g)];
    heads.forEach((h, i) => {
      const chunk = php.slice(h.index!, i + 1 < heads.length ? heads[i + 1]!.index : php.indexOf('public static function for_school'));
      for (const m of chunk.matchAll(/\[\s*'key'\s*=>\s*'(\w+)'[\s\S]*?'count'\s*=>\s*(\d+),\s*'marks'\s*=>\s*([\d.]+)/g)) theirs.push({ key: `${h[1]}:${m[1]}`, count: Number(m[2]), marks: Number(m[3]) });
    });
    assert.equal(theirs.length, 14, 'found all 14 plugin sections: ' + theirs.length);
    assert.deepEqual(WAEC_SECTIONS.map((s) => ({ key: s.key, count: s.count, marks: s.marks })), theirs);
  });
} else console.log('SKIP  plugin contract (plugin source not next to this repo)');

console.log(`${count} WAEC blueprint checks passed`);
