'use client';

import Link from 'next/link';

import { Badge, type BadgeProps } from '@/components/ui/badge';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * Mirrors `SearchIntent` in the Prisma schema. Declared as a literal union rather than imported
 * from `@seo/db`, because pulling the Prisma client into a client bundle is both huge and wrong.
 */
export type SearchIntentValue =
  | 'INFORMATIONAL'
  | 'NAVIGATIONAL'
  | 'COMMERCIAL'
  | 'TRANSACTIONAL'
  | 'LOCAL'
  | 'UNKNOWN';

type BadgeTone = NonNullable<BadgeProps['variant']>;

interface IntentStyle {
  /** Two letters at most: an intent badge sits next to the keyword and must not steal the row. */
  short: string;
  label: string;
  tone: BadgeTone;
}

/** Tone follows commercial value: transactional is the money term, informational is top-of-funnel. */
const INTENT_STYLES: Record<SearchIntentValue, IntentStyle> = {
  TRANSACTIONAL: { short: 'Txn', label: 'Transactional', tone: 'success' },
  COMMERCIAL: { short: 'Com', label: 'Commercial', tone: 'warning' },
  INFORMATIONAL: { short: 'Info', label: 'Informational', tone: 'info' },
  NAVIGATIONAL: { short: 'Nav', label: 'Navigational', tone: 'secondary' },
  LOCAL: { short: 'Loc', label: 'Local', tone: 'outline' },
  UNKNOWN: { short: '—', label: 'Unknown intent', tone: 'muted' },
};

export interface KeywordCellProps {
  keyword: string;
  intent?: SearchIntentValue | null;
  /** Cluster name, shown as a chip so related terms are visible without opening the cluster. */
  cluster?: string | null;
  /** Marks the term as branded — branded traffic is read very differently from the rest. */
  branded?: boolean;
  /** Link to the keyword detail screen. */
  href?: string;
  /** Hide the intent badge on screens where every row shares one intent. */
  showIntent?: boolean;
  className?: string;
}

export function KeywordCell({
  keyword,
  intent,
  cluster,
  branded = false,
  href,
  showIntent = true,
  className,
}: KeywordCellProps): React.JSX.Element {
  const style = intent ? INTENT_STYLES[intent] : null;

  return (
    <div className={cn('flex min-w-0 items-center gap-1.5', className)}>
      {href ? (
        // In-app destination — client navigation, not a document reload.
        <Link
          href={href}
          title={keyword}
          className="truncate font-medium text-foreground underline-offset-4 hover:text-primary hover:underline"
        >
          {keyword}
        </Link>
      ) : (
        <span title={keyword} className="truncate text-foreground">
          {keyword}
        </span>
      )}

      {branded ? (
        <SimpleTooltip content="Branded query">
          <Badge variant="outline" className="shrink-0">
            Brand
          </Badge>
        </SimpleTooltip>
      ) : null}

      {showIntent && style && intent !== 'UNKNOWN' ? (
        <SimpleTooltip content={style.label}>
          <Badge variant={style.tone} className="shrink-0">
            {style.short}
          </Badge>
        </SimpleTooltip>
      ) : null}

      {cluster ? (
        <SimpleTooltip content={`Cluster: ${cluster}`}>
          <span className="max-w-[10rem] shrink-0 truncate rounded-md bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
            {cluster}
          </span>
        </SimpleTooltip>
      ) : null}
    </div>
  );
}
