/**
 * Document templates over HTTP, against two running servers on the SAME disposable local database:
 *   CA_TEST_HTTP_URL       this branch
 *   CA_TEST_BASELINE_URL   the same code on `main`, before templates existed (the reference)
 *
 *   npm run test:templates-http
 *
 *  1. With nothing assigned, no document carries a `tpl-` class.
 *  2. With nothing assigned, the report card, class print, transcript and broadsheet are BYTE-IDENTICAL to `main`
 *     (after replacing ids and build hashes that differ between runs).
 *  3. With a design assigned, each of the four documents carries `tpl-<key>` on the root `.doc`, for every design.
 *  4. Assigning "classic" explicitly is also identical to `main` (classic adds no class).
 *  5. Another school is unaffected by this school's assignment.
 *  6. The platform-admin preview: 200 for every known kind and design with sample data only, 404 for unknown input,
 *     and no platform session = no preview.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { reportFixtureEnv } from './report-fixture';
import { TEMPLATES, DOC_KINDS } from '@/lib/templates/registry';

let failures = 0;
let createdAdmin = 0;
const check = (name: string, ok: boolean, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); if (!ok) failures++; };
const local = (u: string) => { const h = new URL(u).hostname; assert(['127.0.0.1', 'localhost'].includes(h), 'local servers only'); return new URL(u); };

async function main() {
  const base = local(process.env.CA_TEST_HTTP_URL ?? '');
  const ref = local(process.env.CA_TEST_BASELINE_URL ?? '');
  const env = await reportFixtureEnv();
  // Only what legitimately differs between two builds or two runs is replaced: asset hashes, server-action ids, stylesheet
  // and preload tags, ids, serials, dates. The document markup itself is compared exactly.
  const stable = (html: string) => html
    .replace(/<script[\s\S]*?<\/script>/g, '').replace(/\s+/g, ' ').replace(/data-dpl-id="[^"]*"/g, '')
    .replace(/<link[^>]*>/g, '').replace(/<meta[^>]*>/g, '')
    .replace(/\$ACTION_ID_[0-9a-f]+/g, '$ACTION_ID_X').replace(/\/_next\/static\/[^"')]+/g, '/_next/static/X')
    .replace(/\/portal\/reports\/\d+/g, '/portal/reports/ID').replace(/(term|class)=\d+/g, '$1=N')
    .replace(/[A-Z]{2}-[0-9A-F-]{36}\/TR\/\d{4}\/\d+/g, 'SERIAL').replace(/%2F/g, '/').replace(/code=[0-9a-zA-Z.-]+/g, 'code=C')
    .replace(/\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?/g, 'DATE');
  try {
    const f = await env.build({ crest: true });
    await f.compile(f.classA.id); await f.move(f.classA.id, 'reviewed'); await f.move(f.classA.id, 'published');
    const { issueTranscript } = await import('@/lib/promotion/transcript');
    const principal = await env.db.select().from(env.schema.users).where((await import('drizzle-orm')).eq(env.schema.users.id, f.principalUser.id)).limit(1);
    const actor = { schoolId: f.schoolId, userId: f.principalUser.id, role: 'principal', loginId: principal[0]!.loginId, staffId: null, studentId: null } as never;
    const issued = await issueTranscript(actor, f.studentsA[0]!.id, 'templates http test') as { serial?: string } | string;
    const serial = typeof issued === 'string' ? issued : issued?.serial;
    assert(serial, 'a transcript serial is needed');
    const token = await env.sessionToken(f.principalUser.id);
    const get = async (b: URL, path: string, cookie = token) => {
      const r = await fetch(new URL(path, b), { headers: cookie ? { cookie: 'educbt.session=' + cookie } : {}, redirect: 'manual', signal: AbortSignal.timeout(40000) });
      return { status: r.status, body: await r.text() };
    };
    const docs: Array<[string, string]> = [
      ['report card', `/portal/reports/${f.studentsA[0]!.id}?term=${f.term.id}`],
      ['class print', `/portal/reports/class?class=${f.classA.id}&term=${f.term.id}`],
      ['transcript', `/portal/transcripts/${encodeURIComponent(serial)}`],
      ['broadsheet', `/portal/broadsheet?class=${f.classA.id}&term=${f.term.id}`],
    ];
    const setRow = async (a: string | null, b: string | null, c: string | null) => {
      await env.db.execute((await import('drizzle-orm')).sql`DELETE FROM school_document_templates WHERE school_id = ${f.schoolId}`);
      if (a || b || c) await env.db.execute((await import('drizzle-orm')).sql`INSERT INTO school_document_templates (school_id, report_template, transcript_template, broadsheet_template) VALUES (${f.schoolId}, ${a}, ${b}, ${c})`);
    };
    const rootClass = (html: string) => (html.match(/<div class="(doc[^"]*)"/g) ?? []).map((m) => m.slice(12, -1));
    const hasTpl = (html: string) => /class="[^"]*\btpl-[a-z]+/.test(html);

    // 1 + 2: nothing assigned
    await setRow(null, null, null);
    for (const [name, path] of docs) {
      const mine = await get(base, path), theirs = await get(ref, path);
      check(`${name}: served (200) on both builds`, mine.status === 200 && theirs.status === 200, `${mine.status}/${theirs.status}`);
      check(`${name}: no design assigned carries no tpl- class (1)`, !hasTpl(mine.body));
      check(`${name}: byte-identical to main when nothing is assigned (2)`, stable(mine.body) === stable(theirs.body), `${stable(mine.body).length} vs ${stable(theirs.body).length}`);
    }
    // 4: explicit classic
    await setRow('classic', 'classic', 'classic');
    for (const [name, path] of docs) {
      const mine = await get(base, path), theirs = await get(ref, path);
      check(`${name}: explicit classic is byte-identical to main and adds no class (4)`, stable(mine.body) === stable(theirs.body) && !hasTpl(mine.body));
    }
    // 3: every design on every document
    for (const t of TEMPLATES.filter((x) => x.key !== 'classic')) {
      await setRow(t.key, t.key, t.key);
      for (const [name, path] of docs) {
        const r = await get(base, path);
        check(`${name}: ${t.key} puts tpl-${t.key} on the root .doc (3)`, r.status === 200 && new RegExp(`class="doc[^"]*\\btpl-${t.key}\\b`).test(r.body), rootClass(r.body).join(' | '));
      }
    }
    // each document follows ITS OWN setting
    await setRow('heritage', 'metro', 'ledger');
    const mixed = await Promise.all(docs.map(([, p]) => get(base, p)));
    const want = ['heritage', 'heritage', 'metro', 'ledger'];
    docs.forEach(([name], i) => check(`${name}: follows its own document setting (3)`, new RegExp(`class="doc[^"]*\\btpl-${want[i]}\\b`).test(mixed[i]!.body)));
    // 5: another school unaffected
    const g = await env.build({ crest: false });
    await g.compile(g.classA.id); await g.move(g.classA.id, 'reviewed'); await g.move(g.classA.id, 'published');
    const tokenG = await env.sessionToken(g.principalUser.id);
    const other = await get(base, `/portal/reports/${g.studentsA[0]!.id}?term=${g.term.id}`, tokenG);
    check('another school keeps classic when this one is re-skinned (5)', other.status === 200 && !hasTpl(other.body));

    // 6: preview
    // A real platform administrator, created here and removed in the finally block.
    const { eq, and } = await import('drizzle-orm');
    await env.db.delete(env.schema.users).where(and(eq(env.schema.users.loginId, 'TPLHTTP-ADMIN'), eq(env.schema.users.role, 'platform_admin')));
    const { hashPassword } = await import('@/lib/auth/password');
    const [adminRow] = await env.db.insert(env.schema.users).values({
      schoolId: null, role: 'platform_admin', loginId: 'TPLHTTP-ADMIN', passwordHash: await hashPassword('Fixt-Tpl!2345'), mustChangePassword: false, status: 'active',
    } as never).returning({ id: env.schema.users.id });
    createdAdmin = Number(adminRow!.id);
    const platformToken = await env.sessionToken(createdAdmin);
    {
      const home = await get(base, '/platform/templates', platformToken);
      check('the platform defaults page opens for a platform admin and shows all three groups (2)', home.status === 200 && ['report', 'transcript', 'broadsheet'].every((k) => home.body.includes(`template-group-${k}`)), String(home.status));
      const checkedOf = (h: string) => (h.match(/<input[^>]*type="radio"[^>]*>/g) ?? []).filter((x) => /checked/.test(x)).map((x) => `${(x.match(/name="(\w+)"/) ?? [])[1]}=${(x.match(/value="(\w*)"/) ?? [])[1]}`).sort().join(',');
      check('the platform defaults page has exactly one choice ticked per document: Classic', checkedOf(home.body) === 'broadsheet=classic,report=classic,transcript=classic', checkedOf(home.body));
      const sch = await get(base, `/platform/schools/${f.schoolId}/templates`, platformToken);
      check('the per-school page opens, offers "Inherit the platform default" and says what is printing now', sch.status === 200 && sch.body.includes('Inherit the platform default') && sch.body.includes('Printing now'), String(sch.status));
      const detail = await get(base, `/platform/schools/${f.schoolId}`, platformToken);
      check('the school page links to its document templates', detail.status === 200 && detail.body.includes(`/platform/schools/${f.schoolId}/templates`));
      const newForm = await get(base, '/platform/schools/new', platformToken);
      check('the New school form has the Document templates step', newForm.status === 200 && newForm.body.includes('new-school-templates'), String(newForm.status));
      check('the New school form has Classic preselected for all three documents, nothing else ticked', checkedOf(newForm.body) === 'broadsheet=classic,report=classic,transcript=classic', checkedOf(newForm.body));
      const missing = await get(base, '/platform/schools/999999999/templates', platformToken);
      check('the per-school page for a school that does not exist is a 404', missing.status === 404, String(missing.status));
      // a school's own screens never name the designs or offer a picker
      const school = await get(base, '/portal/settings', token);
      const dash = await get(base, '/portal', token);
      const leak = (h: string) => /template-group-|Document templates|Heritage|Ledger|Metro/.test(h);
      check('the school\'s own screens show no template picker and no design names', !leak(school.body) && !leak(dash.body), `${school.status}/${dash.status}`);
    }
    if (platformToken) {
      for (const kind of DOC_KINDS) for (const t of TEMPLATES) {
        const r = await get(base, `/platform/templates/preview?kind=${kind}&template=${t.key}`, platformToken);
        check(`preview ${kind}/${t.key}: 200 with sample data (6)`, r.status === 200 && r.body.includes('Demo International School') && (t.key === 'classic' || r.body.includes(`tpl-${t.key}`)));
      }
      for (const bad of ['kind=nope&template=metro', 'kind=report&template=nope', 'kind=report', 'template=metro', '']) {
        check(`preview with "${bad}" is a 404 (6)`, (await get(base, `/platform/templates/preview?${bad}`, platformToken)).status === 404);
      }
    }
    const anon = await get(base, '/platform/templates/preview?kind=report&template=metro', '');
    check('preview without a platform session shows no document (6)', anon.status !== 200 || !anon.body.includes('Demo International School'), String(anon.status));
    const asPrincipal = await get(base, '/platform/templates/preview?kind=report&template=metro');
    check('a principal session does not get the preview (6)', asPrincipal.status !== 200 || !asPrincipal.body.includes('Demo International School'), String(asPrincipal.status));
    const asPrincipalPage = await get(base, '/platform/templates');
    check('a principal session does not get the platform defaults page (6)', asPrincipalPage.status !== 200 || !asPrincipalPage.body.includes('Save platform defaults'), String(asPrincipalPage.status));
  } finally {
    if (createdAdmin) { const { eq } = await import('drizzle-orm'); await env.db.delete(env.schema.users).where(eq(env.schema.users.id, createdAdmin)); }
    await env.cleanup();
  }
  console.log(failures ? `\n${failures} check(s) FAILED.` : '\nAll template HTTP checks passed.');
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
