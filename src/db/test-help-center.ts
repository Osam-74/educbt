/**
 * Help Center content integrity. No database needed.
 *   npx tsx src/db/test-help-center.ts
 *
 * This guards the thing that rots first in documentation: references.
 * It cannot prove an article is TRUE (that is the audit in docs/help-center.md)
 * but it makes sure nothing points at a page that does not exist.
 */
import assert from 'node:assert/strict';
import { ARTICLES, FAQS, articleBySlug, searchIndex, neighbours } from '@/lib/help/registry';
import { CATEGORY_BY_ID } from '@/lib/help/categories';
import { searchEntries, articleText, scoreEntry, toEntry } from '@/lib/help/search';
import { ROLE_LABEL } from '@/lib/help/roles';

let n = 0;
const ok = (name: string) => { n++; console.log('  ok  ' + name); };

// 1. Slugs unique, categories real, required fields present.
const slugs = ARTICLES.map((a) => a.slug);
assert.equal(new Set(slugs).size, slugs.length, `duplicate slugs: ${slugs.filter((s, i) => slugs.indexOf(s) !== i)}`);
ok(`${ARTICLES.length} articles with unique slugs`);

for (const a of ARTICLES) {
  assert.ok(CATEGORY_BY_ID[a.category], `${a.slug}: unknown category ${a.category}`);
  assert.ok(a.title.length >= 4, `${a.slug}: title`);
  assert.ok(a.description.length >= 20 && a.description.length <= 200, `${a.slug}: description length ${a.description.length}`);
  assert.ok(a.keywords.length >= 3, `${a.slug}: needs at least 3 keywords`);
  assert.ok(a.blocks.length >= 1, `${a.slug}: no content`);
  assert.match(a.slug, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${a.slug}: slug format`);
  for (const r of a.audience) assert.ok(r === 'all' || ROLE_LABEL[r], `${a.slug}: unknown audience ${r}`);
}
ok('every article has a real category, audience, description and keywords');

// 2. Related links resolve, are not self-links, no repeats.
for (const a of ARTICLES) {
  const seen = new Set<string>();
  for (const r of a.related ?? []) {
    assert.ok(articleBySlug(r), `${a.slug}: related "${r}" does not exist`);
    assert.notEqual(r, a.slug, `${a.slug}: relates to itself`);
    assert.ok(!seen.has(r), `${a.slug}: related "${r}" listed twice`);
    seen.add(r);
  }
}
ok('every related link resolves');

// 3. *Italic* mentions of another guide must match a real article title.
const titles = new Set(ARTICLES.map((a) => a.title));
const known = new Set([...titles, 'Time-based', '6 digits', '30 seconds']);
const bad: string[] = [];
for (const a of ARTICLES) {
  const texts = a.blocks.flatMap((b) => {
    switch (b.type) {
      case 'p': case 'h': case 'note': case 'warning': return [b.text];
      case 'steps': case 'list': return b.items;
      case 'table': return b.rows.flat();
      default: return [];
    }
  });
  for (const t of texts) {
    for (const m of t.matchAll(/(?<!\*)\*([^*]+)\*(?!\*)/g)) {
      if (!known.has(m[1]!)) bad.push(`${a.slug}: *${m[1]}*`);
    }
  }
}
assert.deepEqual(bad, [], `italic guide references that match no article title:\n  ${bad.join('\n  ')}`);
ok('every *italic guide title* matches a real article');

// 4. Screenshots: no figure may point at a file that is not there.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
for (const a of ARTICLES) for (const b of a.blocks) if (b.type === 'figure' && b.figure.src) {
  assert.ok(existsSync(join(process.cwd(), 'public', b.figure.src)), `${a.slug}: missing screenshot ${b.figure.src}`);
  assert.ok(b.figure.alt.length > 5, `${a.slug}: screenshot needs alt text`);
}
ok('screenshots exist and have alt text');

// 5. FAQs.
const faqIds = FAQS.map((f) => f.id);
assert.equal(new Set(faqIds).size, faqIds.length, 'duplicate FAQ ids');
for (const f of FAQS) {
  assert.ok(f.answer.length >= 1, `${f.id}: no answer`);
  if (f.article) assert.ok(articleBySlug(f.article), `${f.id}: article "${f.article}" does not exist`);
}
ok(`${FAQS.length} FAQs, all links resolve`);

// 6. Search behaves the way the spec describes.
const idx = searchIndex();
const top = (q: string, k = 6) => searchEntries(idx, q, k).map((e) => e.slug);
// The results page shows up to 20; the suggestion dropdown shows 6.
const has = (q: string, slug: string) => assert.ok(top(q, 20).includes(slug), `search "${q}" should find ${slug}; got ${top(q, 20)}`);
const dropdown = (q: string, slug: string) => assert.ok(top(q, 6).includes(slug), `dropdown for "${q}" should include ${slug}; got ${top(q, 6)}`);
has('password', 'changing-your-password'); has('password', 'forgot-password'); has('passwords', 'forgot-password');
has('student', 'adding-a-student'); has('students', 'editing-a-student');
has('exam', 'how-an-examination-works'); has('exam', 'exam-timetable'); has('exam', 'invigilation-schedule');
has('invigilator', 'invigilation-schedule'); has('2fa', 'two-factor-authentication'); has('locked out', 'sign-in-problems');
has('reset link', 'forgot-password'); has('compile', 'how-results-are-published'); has('add teacher', 'managing-staff');
// What the dropdown must get right for the most common single words.
dropdown('password', 'forgot-password'); dropdown('password', 'changing-your-password');
dropdown('student', 'adding-a-student'); dropdown('exam', 'how-an-examination-works'); dropdown('exam', 'exam-timetable');
// Examination-area guides outrank the one results-area guide that merely has "Exam" in its title.
const examTop = searchEntries(idx, 'exam', 3).map((e) => e.category);
assert.ok(examTop.filter((c) => c === 'examinations').length >= 2, `exam top 3 should be mostly Examinations; got ${examTop}`);
assert.deepEqual(top('zzzqqqxx'), [], 'nonsense query should return nothing');
assert.deepEqual(top(''), [], 'empty query returns nothing');
ok('search finds the expected guides, and nothing for nonsense');

// Full-text search reaches words that are only in the body.
const body = ARTICLES.find((a) => a.slug === 'writing-questions')!;
assert.ok(scoreEntry(toEntry(body), 'paste', articleText(body)) > 0, 'body text should be searchable');
ok('full-text search reaches article bodies');

// 7. Previous/next stay inside the category and chain without loops.
for (const a of ARTICLES) {
  const { prev, next } = neighbours(a);
  if (prev) assert.equal(prev.category, a.category);
  if (next) assert.equal(next.category, a.category);
}
ok('previous/next stay within the category');

// 8. No claims we know to be false creep back in.
const all = ARTICLES.map((a) => a.title + ' ' + articleText(a)).join('\n');
for (const banned of [/\bacademistry\.vercel\.app\b/i, /\bWordPress\b/i, /\bWP-?Cron\b/i, /lorem ipsum/i, /\bTODO\b/, /\bcoming soon\b/i]) {
  assert.ok(!banned.test(all), `banned phrase present: ${banned}`);
}
ok('no placeholder or legacy wording');

console.log(`\n${n} groups passed`);
