/**
 * Editing a term's resumption and closing dates from the calendar (WordPress plugin parity). Pure rules, no database:
 * the service applies them inside the school's transaction. The same terms table School Settings edits is the one
 * written, so there is a single source of truth for term dates.
 */
import { type DateStr, isDateStr, cmp } from './dates';
import type { Term } from './engine';

export type TermDatesInput = { termId: number; startsOn: string; endsOn: string };

/** Returns the reason the dates are refused, or null when they are acceptable. `sessionStart/End` bound the term when set. */
export function termDatesProblem(
  input: TermDatesInput,
  terms: Term[],
  session: { startsOn: DateStr | null; endsOn: DateStr | null } = { startsOn: null, endsOn: null },
): string | null {
  const term = terms.find((t) => t.id === input.termId);
  if (!term) return 'That term was not found in this session.';
  if (!input.startsOn || !input.endsOn) return 'Choose both the resumption date and the closing date.';
  if (!isDateStr(input.startsOn) || !isDateStr(input.endsOn)) return 'Enter real calendar dates.';
  if (cmp(input.endsOn, input.startsOn) < 0) return 'The closing date cannot be before the resumption date.';
  if (session.startsOn && cmp(input.startsOn, session.startsOn) < 0 || session.endsOn && cmp(input.endsOn, session.endsOn) > 0) {
    return 'Term dates must fall within the session dates.';
  }
  const clash = terms.find((t) => t.id !== input.termId && t.startsOn && t.endsOn
    && cmp(input.startsOn, t.endsOn) <= 0 && cmp(input.endsOn, t.startsOn) >= 0);
  if (clash) return `These dates overlap ${clash.title}.`;
  return null;
}
