'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';
import { CopyButton } from './copy-button';
import { TooltipInfo } from './tooltip-info';

interface StatListContextValue {
  dense: boolean;
  divided: boolean;
  layout: 'row' | 'stacked';
}

const StatListContext = React.createContext<StatListContextValue>({
  dense: false,
  divided: false,
  layout: 'row',
});

export interface StatListProps extends React.HTMLAttributes<HTMLDListElement> {
  /** Tighter rows for side panels and popovers. */
  dense?: boolean;
  /** Hairline between rows; helps once a list runs past ~6 entries. */
  divided?: boolean;
  /**
   * `row` puts the value opposite the label; `stacked` puts it underneath, which
   * is the only readable option for long values such as canonical URLs.
   */
  layout?: 'row' | 'stacked';
}

/**
 * Definition list for detail panes — a real `<dl>` so assistive tech reports
 * each value with the term it belongs to, instead of a table of two columns
 * that never had headers.
 */
const StatList = React.forwardRef<HTMLDListElement, StatListProps>(function StatList(
  { dense = false, divided = false, layout = 'row', className, children, ...props },
  ref,
) {
  const context = React.useMemo<StatListContextValue>(() => ({ dense, divided, layout }), [dense, divided, layout]);

  return (
    <StatListContext.Provider value={context}>
      <dl ref={ref} className={cn('w-full', className)} {...props}>
        {children}
      </dl>
    </StatListContext.Provider>
  );
});

export interface StatListItemProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  label: React.ReactNode;
  value: React.ReactNode;
  /** Monospace the value: ids, hashes, selectors, header values. */
  mono?: boolean;
  /** Shows a copy button and copies exactly this string. */
  copyValue?: string;
  /** Explanatory copy behind an “(i)” next to the label. */
  hint?: React.ReactNode;
  /** Renders the value in the muted tone used for “not measured”. */
  muted?: boolean;
}

const StatListItem = React.forwardRef<HTMLDivElement, StatListItemProps>(function StatListItem(
  { label, value, mono = false, copyValue, hint, muted = false, className, ...props },
  ref,
) {
  const { dense, divided, layout } = React.useContext(StatListContext);
  const stacked = layout === 'stacked';

  return (
    <div
      ref={ref}
      className={cn(
        dense ? 'py-1' : 'py-1.5',
        !stacked && 'flex items-baseline justify-between gap-4',
        divided && 'border-b border-border/60 last:border-b-0',
        className,
      )}
      {...props}
    >
      <dt className={cn('flex items-center gap-1 text-xs text-muted-foreground', !stacked && 'shrink-0')}>
        <span className="truncate">{label}</span>
        {hint ? (
          <TooltipInfo content={hint} label={typeof label === 'string' ? `About ${label}` : 'More information'} />
        ) : null}
      </dt>
      <dd
        className={cn(
          'flex min-w-0 items-center gap-1',
          stacked ? 'mt-0.5 justify-start' : 'justify-end text-right',
          mono ? 'font-mono text-2xs' : 'tabular text-xs',
          muted ? 'text-muted-foreground' : 'text-foreground',
        )}
      >
        <span className={cn('min-w-0', stacked ? 'break-all' : 'truncate')}>{value}</span>
        {copyValue !== undefined ? (
          <CopyButton
            value={copyValue}
            label={typeof label === 'string' ? `Copy ${label}` : 'Copy value'}
            className="-my-1 size-6 shrink-0"
          />
        ) : null}
      </dd>
    </div>
  );
});

export { StatList, StatListItem };
