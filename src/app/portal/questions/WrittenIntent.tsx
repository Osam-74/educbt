import { handInSet } from './actions';

/**
 * Written Examination Intent (legacy parity: the #qs-written-panel in
 * templates/portal/exams/questions.php). Selecting Written delivery means
 * the school prints and marks the paper on paper — there is nothing to type
 * into the bank, just an intent to record so the exam office can plan the
 * timetable and invigilation around it. The set behind it already exists
 * (openSet creates it the moment a subject and class are chosen); this just
 * hands it in, and submitSet's written-mode bypass clears it with nothing
 * to review.
 */
export default function WrittenIntent({
  subject,
  level,
  setId,
  returnParams,
  already,
}: {
  subject: string;
  level: string;
  setId: number;
  returnParams: string;
  already: boolean;
}) {
  return (
    <div className="qs-written-panel">
      <h3>Written Examination Intent</h3>
      <p className="muted">
        {subject} — {level} will be examined on paper, not as a CBT. Management will print
        question papers and arrange invigilation. No questions need to be entered here —
        submit this intent so the exam office can include it in the timetable.
      </p>
      {already ? (
        <p className="ok">Written intent already recorded for this subject and class.</p>
      ) : (
        <form action={handInSet}>
          <input type="hidden" name="setId" value={setId} />
          <input type="hidden" name="returnParams" value={returnParams} />
          <input type="hidden" name="written" value="1" />
          <button type="submit" className="sd-action">Submit Written Intent</button>
        </form>
      )}
    </div>
  );
}
