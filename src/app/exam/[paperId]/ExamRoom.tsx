'use client';

/**
 * The exam room.
 *
 * SYNC MODEL — three layers, in the order they run:
 *
 *   1. Local first. The answer is written to localStorage and the UI updates
 *      immediately. A candidate must never wait on a network round trip to see
 *      their own selection registered — at 200ms from Lagos to Ireland, that
 *      wait is the whole feel of the paper.
 *
 *   2. Server sync. The answer is posted straight away with an idempotency key,
 *      so a retry updates the same row instead of creating a second.
 *
 *   3. Retry queue. A failed post goes back on the queue and is retried with
 *      backoff. The candidate is never asked to resubmit anything by hand.
 *
 * The server remains the source of truth throughout. localStorage is an
 * emergency copy for a dropped connection, nothing more.
 *
 * THE TIMER IS DISPLAY ONLY. The countdown below is rendered from a server
 * deadline, but the server decides whether an answer is accepted. A candidate
 * who changes their device clock changes what they see and nothing else.
 *
 * THEORY QUESTIONS are captured through the same model: every keystroke is
 * kept locally, and a debounced post carries the latest text to the server.
 * Debounce (not per-keystroke posts) keeps the paper usable on a slow link —
 * a candidate typing a long answer generates one network write, not hundreds.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

type Option = { id: number; key: string | null; text: string };

type Question = {
  id: number;
  number: number;
  /** 'theory' renders an answer box; everything else renders options. */
  type: string;
  text: string;
  imageUrl: string | null;
  instructions: string | null;
  marks: number;
  options: Option[];
  passage: { title: string; body: string } | null;
};

type SyncState = 'saved' | 'saving' | 'offline' | 'error';

export default function ExamRoom({
  attemptId,
  expiresAtIso,
  questions,
  subjectName,
}: {
  attemptId: number;
  expiresAtIso: string;
  questions: Question[];
  subjectName: string;
}) {
  const storageKey = `educbt:attempt:${attemptId}`;
  const textStorageKey = `educbt:attempt:${attemptId}:text`;

  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [textAnswers, setTextAnswers] = useState<Record<number, string>>({});
  const [bookmarks, setBookmarks] = useState<Record<number, boolean>>({});
  const [sync, setSync] = useState<SyncState>('saved');
  const [remaining, setRemaining] = useState<number>(() =>
    Math.max(0, Math.floor((new Date(expiresAtIso).getTime() - Date.now()) / 1000)),
  );
  const [submitting, setSubmitting] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);

  const queue = useRef<Array<{ questionId: number; optionId?: number; text?: string; key: string }>>([]);
  const flushing = useRef(false);
  const theoryTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});

  // ── Restore from local storage ─────────────────────────────────────────────
  // If the browser crashed, the answers are still here. The server copy is
  // authoritative, but this covers what had not synced yet.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) setAnswers(JSON.parse(saved) as Record<number, number>);
      const savedText = localStorage.getItem(textStorageKey);
      if (savedText) setTextAnswers(JSON.parse(savedText) as Record<number, string>);
    } catch {
      // A blocked or full localStorage must not stop the paper.
    }
  }, [storageKey, textStorageKey]);

  // ── Countdown ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const deadline = new Date(expiresAtIso).getTime();

    const tick = setInterval(() => {
      const left = Math.max(0, Math.floor((deadline - Date.now()) / 1000));
      setRemaining(left);

      // The server sweeper closes the attempt regardless; submitting here just
      // saves the candidate seeing a dead screen.
      if (left === 0) void doSubmit(true);
    }, 1000);

    return () => clearInterval(tick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiresAtIso]);

  // ── Retry queue ────────────────────────────────────────────────────────────
  const flush = useCallback(async () => {
    if (flushing.current || queue.current.length === 0) return;

    flushing.current = true;
    setSync('saving');

    while (queue.current.length > 0) {
      const item = queue.current[0]!;

      try {
        const res = await fetch(`/api/exam/${attemptId}/answer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            questionId: item.questionId,
            optionId: item.optionId,
            text: item.text,
            key: item.key,
          }),
        });

        if (res.status === 409) {
          // Expired or closed. Retrying cannot help, so stop rather than loop.
          queue.current = [];
          setSync('error');
          setWarning('This paper has closed. Your saved answers have been kept.');
          break;
        }

        if (!res.ok) throw new Error('save failed');

        queue.current.shift();
        setSync('saved');
      } catch {
        // Network. Keep the item and try again shortly.
        setSync('offline');
        flushing.current = false;
        setTimeout(() => void flush(), 3000);
        return;
      }
    }

    flushing.current = false;
  }, [attemptId]);

  useEffect(() => {
    const onOnline = () => void flush();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [flush]);

  // ── Integrity signals ──────────────────────────────────────────────────────
  // Reported to the server, so the banner shown to the candidate is true.
  // Failures are swallowed: a dropped report must never interrupt a paper.
  const report = useCallback((type: string) => {
    fetch(`/api/exam/${attemptId}/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type }),
    }).catch(() => {});
  }, [attemptId]);

  useEffect(() => {
    const onContext = (e: MouseEvent) => {
      e.preventDefault();
      report('right_click');
      setWarning('Right-click is disabled during the examination. This has been recorded.');
    };

    const onVisibility = () => {
      if (document.hidden) {
        report('tab_hidden');
        setWarning('You left the examination tab. This has been recorded.');
      }
    };

    const onBlur = () => report('window_blur');

    document.addEventListener('contextmenu', onContext);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onBlur);

    return () => {
      document.removeEventListener('contextmenu', onContext);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
    };
  }, [report]);

  // ── Answering ──────────────────────────────────────────────────────────────
  function choose(questionId: number, optionId: number) {
    const next = { ...answers, [questionId]: optionId };
    setAnswers(next);

    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // Private browsing or a full quota. The server sync below still runs.
    }

    queue.current = queue.current.filter((q) => q.questionId !== questionId);
    queue.current.push({
      questionId,
      optionId,
      // Stable per answer, so a retry is recognised as the same write.
      key: `${attemptId}:${questionId}:${optionId}`,
    });

    void flush();
  }

  /**
   * Theory capture. Local-first like an option tap, then one debounced server
   * write per pause in typing. The timer is reset on every keystroke, so only
   * the latest text is ever posted.
   */
  function writeTheory(questionId: number, value: string) {
    const next = { ...textAnswers, [questionId]: value };
    setTextAnswers(next);

    try {
      localStorage.setItem(textStorageKey, JSON.stringify(next));
    } catch {
      // Private browsing or a full quota. The debounced sync still runs.
    }

    const pending = theoryTimers.current[questionId];
    if (pending) clearTimeout(pending);

    theoryTimers.current[questionId] = setTimeout(() => {
      delete theoryTimers.current[questionId];
      queue.current = queue.current.filter((q) => q.questionId !== questionId);
      queue.current.push({
        questionId,
        text: value,
        // Stable per question, so a retry updates the same row.
        key: `${attemptId}:${questionId}:text`,
      });
      void flush();
    }, 900);
  }

  /** Hand any text still waiting on its debounce to the queue right now. */
  function enqueuePendingTheory() {
    for (const key of Object.keys(theoryTimers.current)) {
      const questionId = Number(key);
      clearTimeout(theoryTimers.current[questionId]);
      delete theoryTimers.current[questionId];
      const value = textAnswers[questionId] ?? '';
      queue.current = queue.current.filter((q) => q.questionId !== questionId);
      queue.current.push({
        questionId,
        text: value,
        key: `${attemptId}:${questionId}:text`,
      });
    }
  }

  // An option question is answered when a choice exists; a theory question
  // when the box holds something other than whitespace.
  function isAnswered(item: Question): boolean {
    return item.type === 'theory'
      ? (textAnswers[item.id] ?? '').trim() !== ''
      : answers[item.id] !== undefined;
  }

  async function doSubmit(auto = false) {
    if (submitting) return;

    if (!auto) {
      const unanswered = questions.filter((q) => !isAnswered(q)).length;
      const message = unanswered > 0
        ? `${unanswered} question${unanswered === 1 ? '' : 's'} unanswered. Submit anyway?`
        : 'Submit your paper? You cannot change your answers afterwards.';

      if (!confirm(message)) return;
    }

    setSubmitting(true);
    enqueuePendingTheory();
    await flush();

    try {
      await fetch(`/api/exam/${attemptId}/submit`, { method: 'POST' });
      localStorage.removeItem(storageKey);
      localStorage.removeItem(textStorageKey);
      window.location.href = '/portal?submitted=1';
    } catch {
      setSubmitting(false);
      setWarning('Submission failed. Check your connection and try again.');
    }
  }

  const q = questions[index];

  if (!q) return <p>This paper has no questions.</p>;

  const answeredCount = questions.filter(isAnswered).length;
  const mm = String(Math.floor(remaining / 60)).padStart(2, '0');
  const ss = String(remaining % 60).padStart(2, '0');
  const low = remaining < 300;

  return (
    <div className="exam">
      <header className="exam__bar">
        <strong>{subjectName}</strong>
        <div className="exam__right">
          <span className={`sync sync--${sync}`}>
            {sync === 'saved' && 'Saved'}
            {sync === 'saving' && 'Saving…'}
            {sync === 'offline' && 'Waiting for connection'}
            {sync === 'error' && 'Closed'}
          </span>
          <span className={`timer${low ? ' timer--low' : ''}`}>{mm}:{ss}</span>
        </div>
      </header>

      {warning ? (
        <div className="exam__warn" role="alert">
          {warning}
          <button type="button" onClick={() => setWarning(null)}>Dismiss</button>
        </div>
      ) : null}

      <div className="exam__body">
        <main className="exam__main">
          {q.passage ? (
            <div className="passage">
              <h3>{q.passage.title}</h3>
              {/* Paragraph breaks preserved — a comprehension passage without
                  them is far harder to read under exam conditions. */}
              {q.passage.body.split('\n').filter(Boolean).map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </div>
          ) : null}

          {q.instructions ? <p className="exam__instr">{q.instructions}</p> : null}

          <p className="exam__num">
            Question {q.number} of {questions.length}
            <span className="muted"> · {q.marks} mark{q.marks === 1 ? '' : 's'}</span>
          </p>

          <p className="exam__text">{q.text}</p>

          {q.imageUrl ? <img className="exam__img" src={q.imageUrl} alt="" /> : null}

          {q.type === 'theory' ? (
            /* The theory answer box. Spellcheck is off: an examiner marks the
               content, and browser suggestions would help some candidates
               more than others. */
            <textarea
              className="exam__theory"
              value={textAnswers[q.id] ?? ''}
              onChange={(e) => writeTheory(q.id, e.target.value)}
              placeholder="Type your answer here…"
              rows={12}
              spellCheck={false}
            />
          ) : (
            /* Short options sit two-up, the way a printed paper prints them, so
               the whole set is visible without scrolling on a small screen. */
            <div className={`exam__options${q.options.every((o) => o.text.length <= 24) ? ' exam__options--grid' : ''}`}>
              {q.options.map((o) => {
                const chosen = answers[q.id] === o.id;

                return (
                  <button
                    type="button"
                    key={o.id}
                    className={`opt${chosen ? ' opt--chosen' : ''}`}
                    onClick={() => choose(q.id, o.id)}
                  >
                    <span className="opt__key">{o.key ?? ''}</span>
                    <span>{o.text}</span>
                  </button>
                );
              })}
            </div>
          )}

          <div className="exam__nav">
            <button type="button" onClick={() => setIndex((i) => Math.max(0, i - 1))} disabled={index === 0}>
              Previous
            </button>
            <button
              type="button"
              onClick={() => setBookmarks((b) => ({ ...b, [q.id]: !b[q.id] }))}
            >
              {bookmarks[q.id] ? 'Remove bookmark' : 'Bookmark'}
            </button>
            <button
              type="button"
              onClick={() => setIndex((i) => Math.min(questions.length - 1, i + 1))}
              disabled={index === questions.length - 1}
            >
              Next
            </button>
          </div>
        </main>

        <aside className="exam__palette">
          <p className="muted">
            {answeredCount} of {questions.length} answered
          </p>
          <div className="palette">
            {questions.map((item, i) => (
              <button
                type="button"
                key={item.id}
                className={
                  'pal'
                  + (isAnswered(item) ? ' pal--done' : '')
                  + (bookmarks[item.id] ? ' pal--marked' : '')
                  + (i === index ? ' pal--here' : '')
                }
                onClick={() => setIndex(i)}
              >
                {item.number}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="exam__submit"
            onClick={() => void doSubmit(false)}
            disabled={submitting}
          >
            {submitting ? 'Submitting…' : 'Submit paper'}
          </button>
        </aside>
      </div>
    </div>
  );
}
