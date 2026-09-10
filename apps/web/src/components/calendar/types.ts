import { CalendarCheck, CircleDot, FileEdit, Rocket, ScanSearch, ShieldCheck, XCircle, type LucideIcon } from 'lucide-react';

/**
 * Client-safe shapes for the content calendar.
 *
 * The read model returns the 17-value `ContentStage` enum; the calendar shows the six phases an
 * editor actually plans around. The mapping is one function, below, so the grid, the list and
 * the filter can never disagree about which bucket an entry is in.
 */

export type CalendarDateKind = 'published' | 'scheduled' | 'updated';

export interface CalendarEntryView {
  id: string;
  websiteId: string;
  websiteName: string;
  title: string;
  /** Raw pipeline stage, kept so the entry can name the exact step it is on. */
  stage: string;
  stageStatus: string;
  targetKeyword: string | null;
  wordCount: number;
  /** `YYYY-MM-DD` in UTC. */
  date: string;
  dateKind: CalendarDateKind;
  publishedUrl: string | null;
}

export const CALENDAR_PHASES = [
  'proposed',
  'drafting',
  'review',
  'approved',
  'scheduled',
  'published',
  'rejected',
] as const;

export type CalendarPhase = (typeof CALENDAR_PHASES)[number];

export type Tone = 'default' | 'secondary' | 'outline' | 'success' | 'warning' | 'destructive' | 'info' | 'muted';

export interface PhaseMeta {
  label: string;
  icon: LucideIcon;
  tone: Tone;
  /** Border/dot colour, via a CSS variable — never a literal colour. */
  dotClass: string;
  description: string;
}

export const PHASE_META: Record<CalendarPhase, PhaseMeta> = {
  proposed: {
    label: 'Proposed',
    icon: CircleDot,
    tone: 'muted',
    dotClass: 'bg-muted-foreground',
    description: 'Researched and briefed, but no prose written yet.',
  },
  drafting: {
    label: 'Drafting',
    icon: FileEdit,
    tone: 'info',
    dotClass: 'bg-info',
    description: 'The body is being written.',
  },
  review: {
    label: 'Review',
    icon: ScanSearch,
    tone: 'warning',
    dotClass: 'bg-warning',
    description: 'Fact check, SEO, brand and quality passes — the gates before a person sees it.',
  },
  approved: {
    label: 'Approved',
    icon: ShieldCheck,
    tone: 'secondary',
    dotClass: 'bg-secondary-foreground',
    description: 'Signed off, waiting on a publish date or the CMS adapter.',
  },
  scheduled: {
    label: 'Scheduled',
    icon: CalendarCheck,
    tone: 'default',
    dotClass: 'bg-primary',
    description: 'Has a publish date set. It sits on that day in the calendar.',
  },
  published: {
    label: 'Published',
    icon: Rocket,
    tone: 'success',
    dotClass: 'bg-success',
    description: 'Live on the site, placed on the day it went out.',
  },
  rejected: {
    label: 'Rejected',
    icon: XCircle,
    tone: 'destructive',
    dotClass: 'bg-destructive',
    description: 'Stopped deliberately. Kept on the calendar so the slot is not silently empty.',
  },
};

const REVIEW_STAGES = new Set([
  'FACT_CHECK',
  'SEO_OPTIMISATION',
  'BRAND_REVIEW',
  'INTERNAL_LINKING',
  'STRUCTURED_DATA',
  'QUALITY_REVIEW',
  'READY_FOR_APPROVAL',
]);

/**
 * Which of the six planning phases an entry belongs to.
 *
 * A publish date wins over the pipeline stage, because that is the fact an editor is planning
 * around: a draft with a date on it is scheduled work whatever step it is currently on.
 */
export function phaseOf(entry: Pick<CalendarEntryView, 'stage' | 'dateKind'>): CalendarPhase {
  if (entry.stage === 'PUBLISHED') return 'published';
  if (entry.stage === 'REJECTED') return 'rejected';
  if (entry.dateKind === 'scheduled') return 'scheduled';
  if (entry.stage === 'APPROVED') return 'approved';
  if (entry.stage === 'DRAFT') return 'drafting';
  if (REVIEW_STAGES.has(entry.stage)) return 'review';
  return 'proposed';
}

export function isCalendarPhase(value: string): value is CalendarPhase {
  return (CALENDAR_PHASES as readonly string[]).includes(value);
}

/** How an entry earned its place on that day — never guessed, always the stored fact. */
export const DATE_KIND_LABEL: Record<CalendarDateKind, string> = {
  published: 'Published',
  scheduled: 'Scheduled for',
  updated: 'Last moved',
};
