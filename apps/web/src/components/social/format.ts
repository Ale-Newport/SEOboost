import type { BadgeProps } from '@/components/ui/badge';
import type {
  ConversationStatusValue,
  PlatformTextRulesWire,
  PolicyValue,
  PostStatusValue,
  SocialPlatformValue,
} from './types';

/**
 * Display helpers for the Social screen. Pure and client-safe: the character counting mirrors
 * the server's platform rules (graphemes; fixed-weight URLs on X and Mastodon) so the counter in
 * a dialog agrees with the guardrail that will check the same text at publish time.
 */

type BadgeVariant = NonNullable<BadgeProps['variant']>;

export const PLATFORM_LABEL: Record<SocialPlatformValue, string> = {
  REDDIT: 'Reddit',
  HACKER_NEWS: 'Hacker News',
  X: 'X',
  BLUESKY: 'Bluesky',
  MASTODON: 'Mastodon',
  LINKEDIN: 'LinkedIn',
  DEVTO: 'Dev.to',
  TELEGRAM: 'Telegram',
  DISCORD: 'Discord',
  YOUTUBE: 'YouTube',
  GITHUB: 'GitHub',
  FACEBOOK: 'Facebook',
  INSTAGRAM: 'Instagram',
  V2EX: 'V2EX',
};

export const POLICY_META: Record<PolicyValue, { label: string; variant: BadgeVariant; description: string }> = {
  ALLOWED: {
    label: 'Promo allowed',
    variant: 'success',
    description: 'The rules explicitly welcome makers sharing their work. A disclosed, relevant mention is fine.',
  },
  RESTRICTED: {
    label: 'Promo restricted',
    variant: 'warning',
    description: 'Self-promotion is limited here (a weekly thread, a ratio, mod approval). Replies stay link-free.',
  },
  FORBIDDEN: {
    label: 'No promotion',
    variant: 'destructive',
    description: 'The rules forbid self-promotion. Replies may help, but must not name or link the product.',
  },
  UNKNOWN: {
    label: 'Rules unchecked',
    variant: 'muted',
    description: 'The rules have not been read yet, or say nothing about promotion. Read them before approving a reply.',
  },
};

export const CONVERSATION_STATUS_META: Record<ConversationStatusValue, { label: string; variant: BadgeVariant }> = {
  NEW: { label: 'New', variant: 'info' },
  SHORTLISTED: { label: 'Shortlisted', variant: 'success' },
  DRAFTED: { label: 'Reply drafted', variant: 'secondary' },
  REPLIED: { label: 'Replied', variant: 'outline' },
  DISMISSED: { label: 'Dismissed', variant: 'muted' },
  EXPIRED: { label: 'Expired', variant: 'muted' },
};

export const POST_STATUS_META: Record<PostStatusValue, { label: string; variant: BadgeVariant }> = {
  DRAFT: { label: 'Draft', variant: 'muted' },
  AWAITING_APPROVAL: { label: 'Awaiting approval', variant: 'warning' },
  APPROVED: { label: 'Approved', variant: 'info' },
  SCHEDULED: { label: 'Scheduled', variant: 'info' },
  PUBLISHING: { label: 'Publishing', variant: 'info' },
  PUBLISHED: { label: 'Published', variant: 'success' },
  MANUAL_PENDING: { label: 'Post by hand', variant: 'warning' },
  FAILED: { label: 'Failed', variant: 'destructive' },
  REJECTED: { label: 'Rejected', variant: 'muted' },
  CANCELLED: { label: 'Cancelled', variant: 'muted' },
};

export const INTENT_LABEL: Record<string, string> = {
  'seeking-recommendation': 'Asking for a recommendation',
  comparison: 'Comparing options',
  problem: 'Describes a problem',
  'competitor-mention': 'Mentions a competitor',
  'brand-mention': 'Mentions us',
  discussion: 'Discussion',
};

export const APPROACH_LABEL: Record<string, string> = {
  REPLY_WITH_PRODUCT: 'Reply, product is a fit',
  HELPFUL_NO_PRODUCT: 'Help without the product',
  ENGAGE_BRAND_MENTION: 'Answer the mention',
  SKIP: 'Skip',
};

const DATE_TIME = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

export function formatDateTime(iso: string | null): string {
  return iso ? DATE_TIME.format(new Date(iso)) : '—';
}

/** `3h ago`, `in 2d` — coarse on purpose; the exact time is in the tooltip. */
export function relativeTime(iso: string | null, now = Date.now()): string {
  if (!iso) return '—';
  const diff = new Date(iso).getTime() - now;
  const abs = Math.abs(diff);
  const units: Array<[number, string]> = [
    [86_400_000, 'd'],
    [3_600_000, 'h'],
    [60_000, 'm'],
  ];
  for (const [size, unit] of units) {
    if (abs >= size) {
      const value = Math.round(abs / size);
      return diff < 0 ? `${value}${unit} ago` : `in ${value}${unit}`;
    }
  }
  return diff < 0 ? 'just now' : 'in a moment';
}

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/g;

let segmenter: Intl.Segmenter | null = null;

function graphemes(text: string): number {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let count = 0;
  for (const _ of segmenter.segment(text)) count++;
  return count;
}

/** Length as the platform counts it — the same rule the publish-time guardrail applies. */
export function platformLength(text: string, rules: PlatformTextRulesWire): number {
  if (rules.urlWeight === null) return graphemes(text);
  const urls = text.match(URL_PATTERN) ?? [];
  return graphemes(text.replace(URL_PATTERN, '')) + urls.length * rules.urlWeight;
}

function normalise(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}.]+/gu, ' ');
}

export function mentionsAny(text: string, terms: readonly string[]): boolean {
  const haystack = ` ${normalise(text)} `;
  return terms.some((term) => term.trim().length >= 3 && haystack.includes(` ${normalise(term).trim()} `));
}

const DISCLOSURE_HINTS = [
  /\b(full )?disclosure\b/,
  /\bi('m| am) (the |a )?(founder|co-?founder|maker|creator|developer|dev|author|owner)\b/,
  /\b(i|we) (built|made|created|run|maintain|work on)\b/,
  /\bsoy (el |la )?(fundador|fundadora|cofundador|creador|creadora|desarrollador|desarrolladora|autor|autora)\b/,
  /\b(lo|la) (he|hemos) (creado|hecho|desarrollado)\b/,
];

/**
 * A quick client-side read of whether the text discloses an affiliation. Advisory only: the
 * server's guardrail is the check that blocks a post; this just warns before the operator saves.
 */
export function looksDisclosed(text: string, configured: string | null): boolean {
  const lower = text.toLowerCase().replace(/[‘’]/g, "'");
  if (configured && configured.trim().length > 3 && lower.includes(configured.trim().toLowerCase())) return true;
  const plain = lower.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  return DISCLOSURE_HINTS.some((pattern) => pattern.test(plain));
}

/** `datetime-local` value (local time, minute precision) for an ISO string. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** ISO string for a `datetime-local` value, or null when empty/invalid. */
export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export const METRIC_LABEL: Record<string, string> = {
  score: 'score',
  likes: 'likes',
  comments: 'comments',
  reposts: 'reposts',
  views: 'views',
};
