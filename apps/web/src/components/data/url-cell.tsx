'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Check, Copy, ExternalLink } from 'lucide-react';

import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn, shortenUrl } from '@/lib/utils';

export interface UrlCellProps {
  url: string;
  /** Overrides the derived path, e.g. a page title. The full URL still shows on hover. */
  label?: string;
  /** Characters before the path is elided. */
  maxLength?: number;
  showCopy?: boolean;
  showExternal?: boolean;
  /** Internal destination — makes the label itself a link to the page detail screen. */
  href?: string;
  className?: string;
}

/** Copy state that resets itself, so the check mark never sticks around. */
function useCopied(resetMs = 1600): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(
    (text: string) => {
      // `navigator.clipboard` is undefined outside secure contexts; fail quietly rather than throw.
      void navigator.clipboard?.writeText(text).then(
        () => {
          setCopied(true);
          if (timer.current !== null) window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), resetMs);
        },
        () => setCopied(false),
      );
    },
    [resetMs],
  );

  return [copied, copy];
}

/**
 * A URL in a dense table: the path only (the host is the same for every row on a site screen),
 * elided from the right, with the full address on hover and a one-click copy.
 */
export function UrlCell({
  url,
  label,
  maxLength = 48,
  showCopy = true,
  showExternal = true,
  href,
  className,
}: UrlCellProps): React.JSX.Element {
  const [copied, copy] = useCopied();
  const display = label ?? shortenUrl(url, maxLength);

  return (
    <div className={cn('group/url flex min-w-0 items-center gap-1', className)}>
      {href ? (
        // `Link`, not `<a>`: this points at another screen in the app, and a full document reload
        // would throw away the router cache and the table state around it.
        <Link
          href={href}
          title={url}
          className="truncate font-medium text-foreground underline-offset-4 hover:text-primary hover:underline"
        >
          {display}
        </Link>
      ) : (
        <span title={url} className="truncate text-foreground">
          {display}
        </span>
      )}

      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/url:opacity-100">
        {showCopy ? (
          <SimpleTooltip content={copied ? 'Copied' : 'Copy URL'}>
            <button
              type="button"
              data-row-ignore
              onClick={(event) => {
                event.stopPropagation();
                copy(url);
              }}
              aria-label={`Copy ${url}`}
              className="flex size-5 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {copied ? (
                <Check className="size-3 text-success" aria-hidden="true" />
              ) : (
                <Copy className="size-3" aria-hidden="true" />
              )}
            </button>
          </SimpleTooltip>
        ) : null}

        {showExternal ? (
          <SimpleTooltip content="Open in a new tab">
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              data-row-ignore
              onClick={(event) => event.stopPropagation()}
              aria-label={`Open ${url} in a new tab`}
              className="flex size-5 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <ExternalLink className="size-3" aria-hidden="true" />
            </a>
          </SimpleTooltip>
        ) : null}
      </span>
    </div>
  );
}
