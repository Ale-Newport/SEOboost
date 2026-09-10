import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * A readable rendering of the free-form JSON agents attach to actions and approvals.
 *
 * `<pre>{JSON.stringify(…)}</pre>` is unreadable at the sizes these blobs reach, so objects
 * become definition lists, arrays become ordered lists, and anything nested more than two levels
 * deep collapses behind a native `<details>` — no state, no client bundle, and the browser's own
 * find-in-page still reaches the closed content.
 */

type Json = unknown;

function isPlainObject(value: Json): value is Record<string, Json> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `targetUrl` / `target_url` / `TARGET-URL` → `Target url`. */
export function humanizeKey(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function isUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value);
}

function Scalar({ value }: { value: Json }): React.JSX.Element {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground">—</span>;
  }
  if (typeof value === 'boolean') {
    return (
      <span className={value ? 'font-medium text-success' : 'text-muted-foreground'}>{value ? 'Yes' : 'No'}</span>
    );
  }
  if (typeof value === 'number') {
    return <span className="tabular text-foreground">{value.toLocaleString()}</span>;
  }
  const text = String(value);
  if (text.length === 0) {
    return <span className="text-muted-foreground">(empty)</span>;
  }
  if (isUrl(text)) {
    return (
      <a
        href={text}
        target="_blank"
        rel="noopener noreferrer"
        className="break-all font-mono text-2xs text-primary underline-offset-4 hover:underline"
      >
        {text}
      </a>
    );
  }
  return <span className="whitespace-pre-wrap break-words text-foreground">{text}</span>;
}

const MAX_INLINE_DEPTH = 2;

export interface JsonViewProps {
  value: Json;
  /** Nesting level; callers start at 0. */
  depth?: number;
  className?: string;
}

export function JsonView({ value, depth = 0, className }: JsonViewProps): React.JSX.Element {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span className="text-2xs text-muted-foreground">Empty list</span>;
    }
    const scalarOnly = value.every((entry) => !isPlainObject(entry) && !Array.isArray(entry));
    if (scalarOnly) {
      return (
        <ul className={cn('flex flex-wrap gap-1', className)}>
          {value.map((entry, index) => (
            <li
              key={index}
              className="rounded border border-border bg-muted/50 px-1.5 py-0.5 text-2xs text-foreground"
            >
              <Scalar value={entry} />
            </li>
          ))}
        </ul>
      );
    }
    return (
      <ol className={cn('space-y-2', className)}>
        {value.map((entry, index) => (
          <li key={index} className="rounded-md border border-border/70 bg-muted/30 p-2">
            <p className="mb-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              Item {index + 1}
            </p>
            <JsonView value={entry} depth={depth + 1} />
          </li>
        ))}
      </ol>
    );
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return <span className="text-2xs text-muted-foreground">No fields recorded</span>;
    }
    return (
      <dl className={cn('space-y-1.5', className)}>
        {entries.map(([key, entry]) => {
          const nested = isPlainObject(entry) || Array.isArray(entry);
          const collapse = nested && depth >= MAX_INLINE_DEPTH;

          return (
            <div key={key} className={cn(nested ? 'space-y-1' : 'flex items-baseline gap-2')}>
              <dt
                className={cn(
                  'text-2xs font-medium text-muted-foreground',
                  nested ? 'uppercase tracking-wide' : 'shrink-0',
                )}
              >
                {humanizeKey(key)}
              </dt>
              <dd className="min-w-0 flex-1 text-xs">
                {collapse ? (
                  <details className="rounded-md border border-border/70 bg-muted/30 px-2 py-1.5">
                    <summary className="cursor-pointer text-2xs text-muted-foreground marker:text-muted-foreground">
                      {Array.isArray(entry) ? `${entry.length} entries` : 'Show details'}
                    </summary>
                    <div className="mt-2">
                      <JsonView value={entry} depth={depth + 1} />
                    </div>
                  </details>
                ) : nested ? (
                  <div className="rounded-md border border-border/70 bg-muted/30 p-2">
                    <JsonView value={entry} depth={depth + 1} />
                  </div>
                ) : (
                  <Scalar value={entry} />
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    );
  }

  return (
    <div className={className}>
      <Scalar value={value} />
    </div>
  );
}

/** True when there is genuinely something to render — used to pick an empty state instead. */
export function hasJsonContent(value: Json): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return String(value).length > 0;
}
