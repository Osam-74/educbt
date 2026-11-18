/**
 * Pure checks for the route gate's Origin rule. No database, no Next runtime.
 *   npx tsx src/lib/school-backup/guard.test.ts
 */
import assert from 'node:assert/strict';

// guard.ts imports next/server and the auth stack; the rule under test is a pure function, so load it
// through a stub-free path by re-declaring nothing: import only the named export.
async function main() {
  const { sameOrigin } = await import('./guard');
  let n = 0;
  const check = (name: string, fn: () => void) => { fn(); n++; console.log('PASS  ' + name); };

  check('the platform\'s own origin is accepted', () => assert.equal(sameOrigin('https://educbt.deodevs.com', 'educbt.deodevs.com'), true));
  check('a localhost dev origin with a port is accepted', () => assert.equal(sameOrigin('http://localhost:3000', 'localhost:3000'), true));
  check('a different site is refused', () => assert.equal(sameOrigin('https://evil.example', 'educbt.deodevs.com'), false));
  check('a different port is refused', () => assert.equal(sameOrigin('http://localhost:4000', 'localhost:3000'), false));
  check('a school subdomain is NOT the platform host', () => assert.equal(sameOrigin('https://pilot.educbt.deodevs.com', 'educbt.deodevs.com'), false));
  check('a lookalike that merely CONTAINS the host is refused', () => {
    assert.equal(sameOrigin('https://educbt.deodevs.com.evil.example', 'educbt.deodevs.com'), false);
    assert.equal(sameOrigin('https://evil.example/educbt.deodevs.com', 'educbt.deodevs.com'), false);
    assert.equal(sameOrigin('https://xeducbt.deodevs.com', 'educbt.deodevs.com'), false);
  });
  check('a missing Origin is refused (a state change must say where it came from)', () => assert.equal(sameOrigin(null, 'educbt.deodevs.com'), false));
  check('a missing Host is refused', () => assert.equal(sameOrigin('https://educbt.deodevs.com', null), false));
  check('the literal "null" origin (sandboxed iframes, file://) is refused', () => assert.equal(sameOrigin('null', 'educbt.deodevs.com'), false));
  check('garbage is refused, not thrown', () => { for (const bad of ['', 'not a url', '//x', 'javascript:alert(1)']) assert.equal(sameOrigin(bad, 'educbt.deodevs.com'), false); });
  check('userinfo tricks do not fool it', () => assert.equal(sameOrigin('https://educbt.deodevs.com@evil.example', 'educbt.deodevs.com'), false));

  console.log('\n' + n + ' checks passed.');
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
