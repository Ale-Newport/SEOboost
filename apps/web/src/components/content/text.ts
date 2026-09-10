/**
 * Text helpers for the editor.
 *
 * Deliberately duplicated from `@seo/shared/text` rather than imported: that module opens with
 * `import { createHash } from 'node:crypto'`, so pulling it into a `'use client'` component would
 * drag Node built-ins into the browser bundle. The definitions below match the server's — the
 * word count in the editor must be the same number the pipeline stores on the draft.
 */

/** Words, counted the way `countWords` counts them server-side: runs of non-whitespace. */
export function countWords(text: string): number {
  const matches = text.trim().match(/[^\s]+/g);
  return matches === null ? 0 : matches.length;
}

/** Strips markdown syntax down to the prose a reader actually sees. */
export function markdownToText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/^\s{0,3}\d+\.\s+/gm, '')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface MarkdownHeading {
  level: number;
  text: string;
  /** Character offset of the heading in the source, so the editor can scroll to it. */
  offset: number;
}

export function extractHeadings(markdown: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  const pattern = /^[ \t]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*$/gm;
  let match = pattern.exec(markdown);
  while (match !== null) {
    headings.push({ level: match[1]?.length ?? 1, text: (match[2] ?? '').trim(), offset: match.index });
    match = pattern.exec(markdown);
  }
  return headings;
}

/** Escapes a phrase for use inside a regular expression. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * How many times a phrase occurs in the prose, matched on whole words so "seo" does not count
 * the "seo" inside "seoul".
 */
export function countPhrase(text: string, phrase: string): number {
  const needle = phrase.trim();
  if (needle.length === 0) return 0;
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(needle)}(?![\\p{L}\\p{N}])`, 'giu');
  return (text.match(pattern) ?? []).length;
}

/** Share of the prose taken up by a phrase, 0-1. Above ~0.03 reads as stuffing. */
export function keywordDensity(text: string, phrase: string): number {
  const total = countWords(text);
  if (total === 0) return 0;
  const phraseWords = Math.max(1, countWords(phrase));
  return (countPhrase(text, phrase) * phraseWords) / total;
}

/** Mirrors `slugify` from `@seo/shared`: lowercase, ASCII-ish, hyphen separated. */
export function slugify(input: string, maxLength = 80): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
}

export interface PhraseLocation {
  /** 1-based line the phrase appears on. */
  line: number;
  /** `heading` when the line is a markdown heading, `intro` for the first paragraph. */
  where: 'heading' | 'intro' | 'body';
  snippet: string;
}

/** Where a phrase actually appears — the "how often, and where" half of keyword coverage. */
export function locatePhrase(markdown: string, phrase: string, limit = 6): PhraseLocation[] {
  const needle = phrase.trim();
  if (needle.length === 0) return [];
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(needle)}(?![\\p{L}\\p{N}])`, 'iu');
  const lines = markdown.split('\n');

  // "Intro" is everything before the first blank line that follows real prose.
  let firstProseLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim().length > 0 && !line.trim().startsWith('#')) {
      firstProseLine = i;
      break;
    }
  }

  const found: PhraseLocation[] = [];
  for (let i = 0; i < lines.length && found.length < limit; i++) {
    const line = lines[i] ?? '';
    if (!pattern.test(line)) continue;
    const isHeading = /^[ \t]{0,3}#{1,6}[ \t]+/.test(line);
    const isIntro = firstProseLine !== -1 && i >= firstProseLine && i <= firstProseLine + 2;
    found.push({
      line: i + 1,
      where: isHeading ? 'heading' : isIntro ? 'intro' : 'body',
      snippet: line.trim().slice(0, 160),
    });
  }
  return found;
}

const DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeZone: 'UTC',
});

const DATE_TIME_FORMAT = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});

/**
 * Dates render identically on the server and in the browser: a locale-sensitive format would
 * differ between the two and trip React's hydration check on every timestamp in the app.
 */
export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '—' : DATE_FORMAT.format(parsed);
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '—' : DATE_TIME_FORMAT.format(parsed);
}

/** `1400` → `1.4s`, `95000` → `1m 35s`. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
}
