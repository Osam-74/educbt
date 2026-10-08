import type { HelpArticle, HelpCategoryId, HelpFaq } from './types';
import { CATEGORIES } from './categories';
import { toEntry, type SearchEntry } from './search';
import { accountSecurity } from './articles/account-security';
import { examinations } from './articles/examinations';
import { schoolManagement } from './articles/school-management';
import { results } from './articles/results';
import { gettingStarted } from './articles/getting-started';

/**
 * Every article, in one place. To add a category file, import it here and
 * spread it into ARTICLES. Slugs must be unique across ALL categories
 * (checked by the help-center test).
 */
export const ARTICLES: HelpArticle[] = [
  ...gettingStarted,
  ...schoolManagement,
  ...examinations,
  ...results,
  ...accountSecurity,
];

import { FAQ_LIST } from './faqs';
export const FAQS: HelpFaq[] = FAQ_LIST;

export const articleBySlug = (slug: string) => ARTICLES.find((a) => a.slug === slug);
export const articlesIn = (c: HelpCategoryId) => ARTICLES.filter((a) => a.category === c);
export const popularArticles = () => ARTICLES.filter((a) => a.popular);
export const searchIndex = (): SearchEntry[] => ARTICLES.map(toEntry);

/** Categories that actually have something to show. */
export const visibleCategories = () =>
  CATEGORIES.filter((c) => (c.id === 'faq' ? FAQS.length > 0 : articlesIn(c.id).length > 0));

/** Previous / next article within the same category, in listed order. */
export function neighbours(a: HelpArticle) {
  const list = articlesIn(a.category);
  const i = list.findIndex((x) => x.slug === a.slug);
  return { prev: i > 0 ? list[i - 1] : null, next: i >= 0 && i < list.length - 1 ? list[i + 1] : null };
}
