import { diffStats, diffWords } from './word-diff';
import type { ApprovalDiffEntryView } from './diff-view';

/**
 * The one-line "what does this actually change" summary shown on a collapsed card.
 *
 * Every number is counted from the stored diff and payload. A change the agent recorded in a
 * shape nothing here understands reports `empty`, and the card says so — it never rounds an
 * unknown change down to "no change".
 */

export interface ChangeSummary {
  fieldCount: number;
  wordsAdded: number;
  wordsRemoved: number;
  linkCount: number;
  hasStructuredData: boolean;
  hasRedirect: boolean;
  /** Nothing countable was recorded: no field diff, no links, no schema, no redirect. */
  empty: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function summariseChange(
  entries: readonly ApprovalDiffEntryView[],
  payload: Record<string, unknown>,
): ChangeSummary {
  let fieldCount = 0;
  let wordsAdded = 0;
  let wordsRemoved = 0;

  for (const entry of entries) {
    const stats = diffStats(diffWords(entry.before ?? '', entry.after ?? ''));
    if (stats.identical) continue;
    fieldCount += 1;
    wordsAdded += stats.added;
    wordsRemoved += stats.removed;
  }

  const linkCount = Array.isArray(payload.links)
    ? payload.links.filter(
        (link) => isRecord(link) && typeof link.anchor === 'string' && typeof link.href === 'string',
      ).length
    : 0;

  const structuredData = payload.structuredData ?? payload.jsonLd ?? payload.schema ?? null;
  const hasStructuredData = structuredData !== null && structuredData !== undefined;
  const hasRedirect = typeof payload.from === 'string' && typeof payload.to === 'string';

  return {
    fieldCount,
    wordsAdded,
    wordsRemoved,
    linkCount,
    hasStructuredData,
    hasRedirect,
    empty: fieldCount === 0 && linkCount === 0 && !hasStructuredData && !hasRedirect,
  };
}

/** Short chips for the collapsed header, e.g. `2 fields`, `+12 / −4 words`, `3 links`. */
export function summaryChips(summary: ChangeSummary): string[] {
  const chips: string[] = [];
  if (summary.fieldCount > 0) {
    chips.push(`${summary.fieldCount} field${summary.fieldCount === 1 ? '' : 's'}`);
  }
  if (summary.wordsAdded > 0 || summary.wordsRemoved > 0) {
    const parts: string[] = [];
    if (summary.wordsAdded > 0) parts.push(`+${summary.wordsAdded}`);
    if (summary.wordsRemoved > 0) parts.push(`−${summary.wordsRemoved}`);
    chips.push(`${parts.join(' / ')} words`);
  }
  if (summary.linkCount > 0) {
    chips.push(`${summary.linkCount} internal link${summary.linkCount === 1 ? '' : 's'}`);
  }
  if (summary.hasStructuredData) chips.push('JSON-LD');
  if (summary.hasRedirect) chips.push('Redirect');
  return chips;
}
