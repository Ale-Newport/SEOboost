import {
  BadgeCheck,
  BookOpen,
  Braces,
  Brain,
  CalendarCheck,
  CircleSlash,
  ClipboardList,
  Columns3,
  FileText,
  Gauge,
  GitMerge,
  HelpCircle,
  Layers,
  Link2,
  ListTree,
  MousePointerClick,
  PenLine,
  RefreshCw,
  Rocket,
  Scale,
  Search,
  ShieldCheck,
  Sparkles,
  Target,
  Users,
  XCircle,
  type LucideIcon,
} from 'lucide-react';

import type {
  ContentStageValue,
  OpportunityTypeValue,
  PipelineStageValue,
} from './types';

/** Badge tones available in the UI kit; kept local so this module stays a plain data table. */
export type Tone = 'default' | 'secondary' | 'outline' | 'success' | 'warning' | 'destructive' | 'info' | 'muted';

// ── opportunity types ────────────────────────────────────────

export interface OpportunityTypeMeta {
  label: string;
  icon: LucideIcon;
  tone: Tone;
  /**
   * Whether acting on this proposal puts a new URL on the site. The whole point of the
   * discovery pass is that most answers are `false` — this drives the "no new page" callout.
   */
  createsPage: boolean;
  /** One line explaining what this type of work actually is. */
  description: string;
}

export const OPPORTUNITY_TYPE_META: Record<OpportunityTypeValue, OpportunityTypeMeta> = {
  IMPROVE_EXISTING_PAGE: {
    label: 'Improve existing',
    icon: PenLine,
    tone: 'info',
    createsPage: false,
    description: 'A page on this site already targets the query. Deepen and re-optimise it rather than splitting the topic.',
  },
  NEW_ARTICLE: {
    label: 'New article',
    icon: FileText,
    tone: 'default',
    createsPage: true,
    description: 'Nothing on the site plausibly answers this query, so a new editorial page is warranted.',
  },
  NEW_LANDING_PAGE: {
    label: 'New landing page',
    icon: Rocket,
    tone: 'default',
    createsPage: true,
    description: 'A commercial-intent query with no matching landing page.',
  },
  NEW_COMPARISON_PAGE: {
    label: 'Comparison',
    icon: Columns3,
    tone: 'default',
    createsPage: true,
    description: 'A head-to-head comparison query that no existing page addresses.',
  },
  NEW_GLOSSARY_PAGE: {
    label: 'Glossary',
    icon: BookOpen,
    tone: 'default',
    createsPage: true,
    description: 'A definitional query best served by a short, citable glossary entry.',
  },
  NEW_PRODUCT_PAGE: {
    label: 'Product page',
    icon: Layers,
    tone: 'default',
    createsPage: true,
    description: 'A product or category query with no page behind it.',
  },
  ADD_FAQ_SECTION: {
    label: 'FAQ section',
    icon: HelpCircle,
    tone: 'info',
    createsPage: false,
    description: 'The question belongs on a page that already exists — add it as an answerable section, not a new URL.',
  },
  CONTENT_REFRESH: {
    label: 'Refresh',
    icon: RefreshCw,
    tone: 'warning',
    createsPage: false,
    description: 'An existing page is losing traffic. Update the facts and close the gaps competitors now cover.',
  },
  CTR_OPTIMISATION: {
    label: 'CTR rewrite',
    icon: MousePointerClick,
    tone: 'warning',
    createsPage: false,
    description: 'The page already ranks; the snippet is not earning the click. Rewrite the title and meta description.',
  },
  CONSOLIDATE_CANNIBALISATION: {
    label: 'Consolidate',
    icon: GitMerge,
    tone: 'destructive',
    createsPage: false,
    description: 'Several URLs already compete for this query. Merge them before anything else is published.',
  },
  NO_ACTION: {
    label: 'No action',
    icon: CircleSlash,
    tone: 'muted',
    createsPage: false,
    description: 'The query is already served well enough that intervening would cost more than it returns.',
  },
};

export function opportunityTypeMeta(type: string): OpportunityTypeMeta {
  return (
    OPPORTUNITY_TYPE_META[type as OpportunityTypeValue] ?? {
      label: type,
      icon: Target,
      tone: 'muted' as const,
      createsPage: false,
      description: 'Unrecognised opportunity type.',
    }
  );
}

// ── pipeline stages ──────────────────────────────────────────

export interface StageMeta {
  label: string;
  icon: LucideIcon;
  /** Groups the 14 stages into the four phases the board columns are labelled with. */
  phase: 'Research' | 'Plan' | 'Write' | 'Verify' | 'Ship';
  description: string;
}

export const STAGE_META: Record<ContentStageValue, StageMeta> = {
  RESEARCH: {
    label: 'Research',
    icon: Search,
    phase: 'Research',
    description: 'Gathers Search Console queries, People Also Ask questions and the related pages already on this site.',
  },
  INTENT_ANALYSIS: {
    label: 'Intent analysis',
    icon: Brain,
    phase: 'Research',
    description: 'Classifies what the searcher actually wants, which decides the format the page has to take.',
  },
  CANNIBALISATION_CHECK: {
    label: 'Cannibalisation check',
    icon: GitMerge,
    phase: 'Research',
    description: 'Confirms no existing URLs already compete for the query before another page is written.',
  },
  COMPETITOR_ANALYSIS: {
    label: 'Competitor analysis',
    icon: Users,
    phase: 'Research',
    description: 'Reads the stored SERP snapshot to find what ranking pages cover — and what they miss.',
  },
  BRIEF: {
    label: 'Brief',
    icon: ClipboardList,
    phase: 'Plan',
    description: 'Turns the research into a brief: angle, entities, questions to answer and internal link targets.',
  },
  OUTLINE: {
    label: 'Outline',
    icon: ListTree,
    phase: 'Plan',
    description: 'Fixes the heading structure so the draft has a shape before a single sentence is generated.',
  },
  DRAFT: {
    label: 'Draft',
    icon: PenLine,
    phase: 'Write',
    description: 'Writes the body. Anything it cannot source is left as an explicit [VERIFY: …] marker rather than invented.',
  },
  FACT_CHECK: {
    label: 'Fact check',
    icon: ShieldCheck,
    phase: 'Verify',
    description: 'Checks every claim against the brand facts and supplied sources. Whatever it cannot support is flagged.',
  },
  SEO_OPTIMISATION: {
    label: 'SEO optimisation',
    icon: Target,
    phase: 'Verify',
    description: 'On-page pass: title, meta, headings and keyword coverage — including over-optimisation warnings.',
  },
  BRAND_REVIEW: {
    label: 'Brand review',
    icon: BadgeCheck,
    phase: 'Verify',
    description: 'Checks tone, positioning and claims against the knowledge base.',
  },
  INTERNAL_LINKING: {
    label: 'Internal linking',
    icon: Link2,
    phase: 'Verify',
    description: 'Proposes links to existing pages, keeping only anchors that appear verbatim in the draft.',
  },
  STRUCTURED_DATA: {
    label: 'Structured data',
    icon: Braces,
    phase: 'Verify',
    description: 'Generates the schema.org markup the page qualifies for.',
  },
  QUALITY_REVIEW: {
    label: 'Quality review',
    icon: Scale,
    phase: 'Verify',
    description: 'The editorial gate: thin content, keyword stuffing, AI tells and unresolved verification markers.',
  },
  READY_FOR_APPROVAL: {
    label: 'Ready for approval',
    icon: CalendarCheck,
    phase: 'Ship',
    description: 'Every stage has run. A person signs it off before anything reaches the live site.',
  },
  APPROVED: {
    label: 'Approved',
    icon: BadgeCheck,
    phase: 'Ship',
    description: 'Signed off by a human and queued for the CMS adapter.',
  },
  PUBLISHED: {
    label: 'Published',
    icon: Rocket,
    phase: 'Ship',
    description: 'Live on the site.',
  },
  REJECTED: {
    label: 'Rejected',
    icon: XCircle,
    phase: 'Ship',
    description: 'Stopped deliberately. The reason stays on the record so the pass does not re-propose it.',
  },
};

export function stageMeta(stage: string): StageMeta {
  return (
    STAGE_META[stage as ContentStageValue] ?? {
      label: stage,
      icon: Sparkles,
      phase: 'Ship' as const,
      description: 'Unrecognised pipeline stage.',
    }
  );
}

/** Ordinal of a stage within the 14-stage run, or `null` for the terminal states. */
export function stageIndex(stage: ContentStageValue): number | null {
  const index = (PIPELINE_ORDER as readonly string[]).indexOf(stage);
  return index === -1 ? null : index;
}

const PIPELINE_ORDER: readonly PipelineStageValue[] = [
  'RESEARCH',
  'INTENT_ANALYSIS',
  'CANNIBALISATION_CHECK',
  'COMPETITOR_ANALYSIS',
  'BRIEF',
  'OUTLINE',
  'DRAFT',
  'FACT_CHECK',
  'SEO_OPTIMISATION',
  'BRAND_REVIEW',
  'INTERNAL_LINKING',
  'STRUCTURED_DATA',
  'QUALITY_REVIEW',
  'READY_FOR_APPROVAL',
];

// ── SERP length guidance ─────────────────────────────────────

/**
 * The ranges Google renders without truncating, in characters. These drive the meta counters in
 * the editor rail, and match the bounds `stageSeo` uses before it will apply its own suggestion.
 */
export const META_TITLE_RANGE = { min: 30, ideal: 50, max: 60, hardMax: 70 } as const;
export const META_DESCRIPTION_RANGE = { min: 70, ideal: 140, max: 155, hardMax: 165 } as const;
export const SLUG_MAX = 75;

export const SCORE_ICON: Record<'quality' | 'seo' | 'geo' | 'readability', LucideIcon> = {
  quality: Scale,
  seo: Target,
  geo: Gauge,
  readability: BookOpen,
};
