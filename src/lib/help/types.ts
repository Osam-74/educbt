/**
 * Help Center content model.
 *
 * An article is plain typed data — no JSX — so adding or correcting one is a
 * single object in a category file, and the same data feeds the article page,
 * the category page, search, related links and previous/next navigation.
 *
 * RULE: an article may only describe what the application really does. Every
 * label quoted in `steps`/`ui` must match the on-screen text; see
 * docs/help-center.md for the verification checklist and the audit sources.
 */

/** Who an article is written for. 'all' = everyone who can sign in. */
export type HelpRole =
  | 'principal'
  | 'vice_principal'
  | 'exam_officer'
  | 'teacher'
  | 'student'
  | 'parent'
  | 'platform_admin';

export type HelpAudience = HelpRole | 'all';

export type HelpCategoryId =
  | 'getting-started'
  | 'school-management'
  | 'examinations'
  | 'results'
  | 'account-security'
  | 'troubleshooting'
  | 'faq';

/** A screenshot slot. `src` is added only once a REAL capture exists. */
export type HelpFigure = {
  /** Public path, e.g. /help/students-add.png. Omit until a real screenshot exists. */
  src?: string;
  alt: string;
  caption?: string;
  width?: number;
  height?: number;
};

export type HelpBlock =
  | { type: 'p'; text: string }
  | { type: 'h'; text: string }
  | { type: 'steps'; title?: string; items: string[] }
  | { type: 'list'; items: string[] }
  | { type: 'note'; text: string }
  | { type: 'warning'; text: string }
  | { type: 'figure'; figure: HelpFigure }
  | { type: 'table'; head: string[]; rows: string[][] };

export type HelpArticle = {
  slug: string;
  category: HelpCategoryId;
  title: string;
  /** One or two sentences. Shown on cards, in search results and under the title. */
  description: string;
  keywords: string[];
  /** Who this is written for. Used for the "For:" label and role filtering. */
  audience: HelpAudience[];
  /** Where in the app this happens, shown as a path chip, e.g. "School › Students". */
  where?: string;
  blocks: HelpBlock[];
  /** Slugs (same registry) of related articles, in display order. */
  related?: string[];
  /** Popular on the Help home. */
  popular?: boolean;
  /** Short icon key for cards; see HelpIcon. */
  icon?: string;
};

export type HelpFaq = {
  id: string;
  group: 'account' | 'school' | 'examinations' | 'teachers' | 'students';
  question: string;
  /** Plain sentences; one paragraph per entry. */
  answer: string[];
  /** Optional article slug to read next. */
  article?: string;
  audience?: HelpAudience[];
};

export type HelpCategory = {
  id: HelpCategoryId;
  title: string;
  description: string;
  icon: string;
};
