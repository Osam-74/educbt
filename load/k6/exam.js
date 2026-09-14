/**
 * EduCBT load harness (k6) — Phase 1 performance/reliability work.
 *
 * Models one candidate's full examination journey as one VU iteration:
 *
 *   sign-in page → sign-in (server action POST) → exam start + question
 *   retrieval (GET /exam/<paperId>) → 60 answer saves (with ~10% repeated
 *   saves, as the retry queue produces) → periodic mid-exam refresh
 *   (navigation/resume load) → submit.
 *
 * Targets LOCAL/STAGING infrastructure only. The app is designed so that in
 * production each warm serverless instance holds ONE database connection
 * (postgres.js max:1, Fluid compute). To reproduce that fan-out locally,
 * BASE_URLS accepts a comma-separated list of running instances (one port
 * each); candidates are pinned round-robin across instances so N instances
 * ≈ N production instances ≈ N database connections.
 *
 * Usage:
 *   LOAD_MANIFEST=load/manifest.json \
 *   BASE_URLS=http://127.0.0.1:3017,http://127.0.0.1:3018 \
 *   THINK_SECONDS=1 k6 run load/k6/exam.js --vus 100 --iterations 100
 *
 * --vus/--iterations = number of concurrent candidates (100 / 250 / 500).
 * Every candidate sits the paper once (per-vu-iterations model).
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { Trend, Counter } from 'k6/metrics';

// ── Configuration ─────────────────────────────────────────────────────────────

const BASE_URLS = ( __ENV.BASE_URLS ?? 'http://127.0.0.1:3017' ).split(',').map(s => s.trim()).filter(Boolean);
const MANIFEST_PATH = __ENV.LOAD_MANIFEST ?? '../../load/manifest.json';
const THINK_SECONDS = Number(__ENV.THINK_SECONDS ?? 1);
const REPEAT_EVERY = Number(__ENV.REPEAT_EVERY ?? 10); // 1-in-N saves repeated (retry model)
const REFRESH_EVERY = Number(__ENV.REFRESH_EVERY ?? 20); // 1-in-N saves followed by a page refresh
const HOST_SUFFIX = __ENV.HOST_SUFFIX ?? ''; // appended to subdomain if the manifest lacks a host

if (!/^https?:\/\//.test(BASE_URLS[0])) {
  throw new Error('BASE_URLS must start with http:// or https:// (local/staging only).');
}
if (/educbt\.com/.test(BASE_URLS.join(','))) {
  // A hard guard: this harness must never run against production.
  throw new Error('Refusing to run against the production domain. Use local/staging BASE_URLS.');
}

const manifest = new SharedArray('manifest', () => {
  const schools = JSON.parse(open(MANIFEST_PATH));
  if (!Array.isArray(schools) || schools.length === 0) {
    throw new Error(`No schools in ${MANIFEST_PATH} — run: npm run load:seed`);
  }
  return schools;
});

// Candidate identity: the harness is deterministic — VU i is candidate
// (i % candidates-per-school) of school (floor(i / candidates-per-school)).
const PER_SCHOOL = manifest[0].candidates.length;

function candidateFor(vuIndex) {
  const school = manifest[Math.floor(vuIndex / PER_SCHOOL) % manifest.length];
  const candidate = school.candidates[vuIndex % PER_SCHOOL];
  return { school, candidate };
}

// ── Metrics ───────────────────────────────────────────────────────────────────

const signinPageLatency = new Trend('exam_signin_page_latency', true);
const signinLatency = new Trend('exam_signin_latency', true);
const examStartLatency = new Trend('exam_start_latency', true);
const answerSaveLatency = new Trend('answer_save_latency', true);
const answerRepeatLatency = new Trend('answer_repeat_latency', true);
const examRefreshLatency = new Trend('exam_refresh_latency', true);
const submitLatency = new Trend('submit_latency', true);
const payloadBytes = new Counter('exam_payload_bytes');
const answersLost = new Counter('answers_lost');
const submitsRejected = new Counter('submits_rejected');
const journeyFailures = new Counter('journey_failures');

const CANDIDATES = Number(__ENV.CANDIDATES ?? 100);

export const options = {
  scenarios: {
    candidates: {
      executor: 'shared-iterations',
      // Every candidate sits the paper exactly once, concurrently. Defined
      // here, not via --vus/--iterations CLI flags: CLI overrides rebuild the
      // scenario and silently drop maxDuration back to k6's 10m default.
      vus: CANDIDATES,
      iterations: CANDIDATES,
      // A 500-candidate journey on a small single-CPU box can outlast k6's
      // 10-minute default cap - the run ends when all candidates have
      // submitted, not when a timer does.
      maxDuration: '45m',
    },
  },
  // Retained for CI-less runs: the scenario above is the source of truth.

  thresholds: {
    // Answer save must feel immediate — track hard.
    'answer_save_latency': ['p(95)<500'],
    'exam_start_latency': ['p(95)<3000'],
    'submit_latency': ['p(95)<3000'],
    'checks': ['rate>0.99'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(50)', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fail(name) {
  journeyFailures.add(1);
  console.error(`journey failure: ${name} (vu ${__VU})`);
}


// Extract the $ACTION_* hidden inputs from the rendered sign-in form and
// HTML-unescape their values (the encrypted closure arrives with &quot;).
function parseActionFields(body) {
  const fields = {};
  const re = /<input[^>]*name="(\$ACTION[^"]*)"[^>]*>/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const tag = m[0];
    const name = /name="([^"]*)"/.exec(tag)[1];
    const vm = /value="([^"]*)"/.exec(tag);
    fields[name] = vm ? htmlUnescape(vm[1]) : '';
  }
  return fields;
}

function htmlUnescape(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}


// A plain JS object body would be sent as urlencoded, which Next.js refuses
// for server actions — the no-JS action protocol is multipart/form-data with
// exact literal field values (including the JSON-quoted encrypted closure).
function multipart(fields) {
  const boundary = 'k6educbt' + Math.random().toString(16).slice(2);
  let body = '';
  for (const [name, value] of Object.entries(fields)) {
    body += `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  }
  body += `--${boundary}--\r\n`;
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

// ── The candidate journey ─────────────────────────────────────────────────────

export default function () {
  const { school, candidate } = candidateFor(__VU - 1);

  const base = BASE_URLS[(__VU - 1) % BASE_URLS.length];
  const host = HOST_SUFFIX ? `${school.subdomain}${HOST_SUFFIX}` : school.host;
  const headers = { Host: host };

  // 1. Sign-in page (browser loads the form; also fetches the action id).
  const signinPage = http.get(`${base}/sign-in`, { headers, tags: { name: 'signin_page' } });
  signinPageLatency.add(signinPage.timings.duration);
  payloadBytes.add(signinPage.body ? signinPage.body.length : 0);
  if (!check(signinPage, {
    'signin page renders': r => r.status === 200,
  })) {
    fail('signin_page');
    return;
  }

  // The school sign-in uses a BOUND server action: the page renders hidden
  // inputs ($ACTION_REF_1 + $ACTION_1:0/1/2) carrying the action id and the
  // encrypted tenant closure. A no-JS browser POSTs exactly these back as
  // multipart form data (verified against a real browser — values must keep
  // their JSON quoting, e.g. "base64==" with the quotes).
  const actionFields = parseActionFields(signinPage.body);
  // $ACTION_REF_1 carries no value — key presence, not truthiness.
  if (!('$ACTION_REF_1' in actionFields) || !actionFields['$ACTION_1:2']) {
    fail('no_action_fields_in_signin_page');
    return;
  }

  // 2. Sign-in — a plain progressive-enhancement form POST of the server
  //    action (exactly what the browser does without JS).
  const signinBody = multipart({
    ...actionFields,
    next: '/portal',
    loginId: candidate,
    password: school.password,
    totpCode: '',
  });
  const signinRes = http.post(`${base}/sign-in`, signinBody.body, {
    headers: { ...headers, 'Content-Type': signinBody.contentType, 'Origin': `http://${host}` },
    redirects: 0,
    tags: { name: 'signin' },
  });
  signinLatency.add(signinRes.timings.duration);
  if (!check(signinRes, {
    'signin accepted': r => r.status === 303 || r.status === 200,
  })) {
    fail('signin');
    return;
  }

  // The session cookie is Secure (production semantics) and k6 — unlike a
  // real browser, which exempts localhost — refuses to send Secure cookies
  // over http. Extract the token from the sign-in response and set it on the
  // jar ourselves so subsequent requests carry it exactly as a browser would.
  const headerNames = Object.keys(signinRes.headers);
  const setCookieHeader = headerNames.find(h => h.toLowerCase() === 'set-cookie');
  const setCookie = (setCookieHeader && signinRes.headers[setCookieHeader]) || '';
  const sessionMatch = /educbt\.session=([^;]+)/.exec(setCookie);
  if (!sessionMatch) {
    fail('no_session_cookie_after_signin');
    return;
  }
  http.cookieJar().set(`${base}/`, 'educbt.session', sessionMatch[1]);

  // 3. Exam start: the page render calls startAttempt (or resume) and serves
  //    the questions. This is the heaviest GET in the journey.
  const examRes = http.get(`${base}/exam/${school.paperId}`, {
    headers, tags: { name: 'exam_start' },
  });
  examStartLatency.add(examRes.timings.duration);
  payloadBytes.add(examRes.body ? examRes.body.length : 0);
  if (!check(examRes, {
    'exam start ok': r => r.status === 200,
    'exam start renders questions': r => /attemptId/.test(r.body),
  })) {
    fail('exam_start');
    return;
  }

  // The flight payload quotes attemptId once on a fresh start and
  // double-escaped on the resume path — accept both shapes.
  const attemptMatch = /attemptId[\\"]*:\s*(\d+)/.exec(examRes.body);
  if (!attemptMatch) {
    fail('no_attempt_id_in_exam_page');
    return;
  }
  const attemptId = attemptMatch[1];

  // 4. Answer saves — every question, with periodic repeated saves (the
  //    browser's retry queue) and periodic refreshes (navigation/resume).
  const answers = school.answers;
  for (let i = 0; i < answers.length; i++) {
    const a = answers[i];
    const idempotencyKey = `${attemptId}:${a.questionId}:${a.optionId}`;

    const saveRes = http.post(
      `${base}/api/exam/${attemptId}/answer`,
      JSON.stringify({ questionId: a.questionId, optionId: a.optionId, key: idempotencyKey }),
      { headers: { ...headers, 'Content-Type': 'application/json' }, tags: { name: 'answer_save' } },
    );
    answerSaveLatency.add(saveRes.timings.duration);
    if (!check(saveRes, {
      'answer accepted': r => r.status === 200 && JSON.parse(r.body).ok === true,
    })) {
      fail('answer_save');
    }

    // Repeated save — a dropped connection makes the browser retry. Same
    // idempotency key, same answer: must be accepted, not duplicated.
    if (REPEAT_EVERY > 0 && (i + 1) % REPEAT_EVERY === 0) {
      const repeatRes = http.post(
        `${base}/api/exam/${attemptId}/answer`,
        JSON.stringify({ questionId: a.questionId, optionId: a.optionId, key: idempotencyKey }),
        { headers: { ...headers, 'Content-Type': 'application/json' }, tags: { name: 'answer_repeat' } },
      );
      answerRepeatLatency.add(repeatRes.timings.duration);
      if (!check(repeatRes, {
        'repeated answer accepted': r => r.status === 200 && JSON.parse(r.body).ok === true,
      })) {
        fail('answer_repeat');
      }
    }

    // Navigation/refresh — the candidate reloads the paper (resume path,
    // server-authoritative timer, question order stability).
    if (REFRESH_EVERY > 0 && (i + 1) % REFRESH_EVERY === 0) {
      const refreshRes = http.get(`${base}/exam/${school.paperId}`, {
        headers, tags: { name: 'exam_refresh' },
      });
      examRefreshLatency.add(refreshRes.timings.duration);
      // Start renders quote attemptId once; the resume path double-escapes
      // the flight payload - accept both shapes.
      const resumedSameAttempt = r => {
        const m = /attemptId[\\"]*:\s*(\d+)/.exec(r.body || '');
        return r.status === 200 && m !== null && m[1] === attemptId;
      };
      if (!check(refreshRes, {
        'refresh resumes same attempt': resumedSameAttempt,
      })) {
        fail('exam_refresh');
      }
    }

    sleep(THINK_SECONDS);
  }

  // 5. Submit.
  const submitRes = http.post(`${base}/api/exam/${attemptId}/submit`, '', {
    headers: { ...headers, 'Content-Type': 'application/json' }, tags: { name: 'submit' },
  });
  submitLatency.add(submitRes.timings.duration);
  if (!check(submitRes, {
    'submit accepted': r => r.status === 200 && JSON.parse(r.body).ok === true,
  })) {
    submitsRejected.add(1);
    fail('submit');
  }
}

// ── Post-run verification hook ────────────────────────────────────────────────
// handleSummary writes the full JSON summary next to the manifest, so runs are
// comparable over time. The DB-level "no answers lost" verification is done
// from Node after the run (scripts/load-verify.ts) against the same database.

export function handleSummary(data) {
  const out = __ENV.SUMMARY_OUT ?? `load/summary-${__ENV.K6_SYSTEM_TAGS ?? 'run'}.json`;
  return { [out]: JSON.stringify(data, null, 2), stdout: textSummary(data) };
}

function textSummary(data) {
  const t = (name, obj) => {
    const m = data.metrics[name];
    if (!m) return `  ${name}: no samples`;
    const vals = m.values;
    return `  ${name}: p50=${(vals['p(50)'] ?? vals.med ?? vals.avg).toFixed(1)}ms ` +
      `p95=${(vals['p(95)'] ?? vals.avg).toFixed(1)}ms p99=${(vals['p(99)'] ?? vals.avg).toFixed(1)}ms ` +
      `max=${(vals.max ?? 0).toFixed(1)}ms avg=${(vals.avg ?? 0).toFixed(1)}ms`;
  };
  const checks = data.metrics.checks
    ? `checks: ${(data.metrics.checks.values.rate * 100).toFixed(2)}% passed`
    : 'checks: n/a';
  return [
    'EduCBT exam load run — summary',
    `  vus=${data.state?.vuCount ?? 'n/a'} iterations=${data.state?.iterationCount ?? 'n/a'}`,
    `  ${checks}`,
    t('exam_signin_page_latency'),
    t('exam_signin_latency'),
    t('exam_start_latency'),
    t('answer_save_latency'),
    t('answer_repeat_latency'),
    t('exam_refresh_latency'),
    t('submit_latency'),
    `  http_req_duration (all): p50=${data.metrics.http_req_duration.values['p(50)']?.toFixed(1)}ms ` +
      `p95=${data.metrics.http_req_duration.values['p(95)']?.toFixed(1)}ms ` +
      `p99=${data.metrics.http_req_duration.values['p(99)']?.toFixed(1)}ms`,
    `  http_reqs=${data.metrics.http_reqs.values.count} ` +
      `http_req_failed=${(data.metrics.http_req_failed.values.rate * 100).toFixed(2)}%`,
  ].join('\n');
}
