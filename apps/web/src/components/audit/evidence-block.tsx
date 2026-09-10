'use client';

import { CopyButton } from '@/components/ui/copy-button';
import { cn } from '@/lib/utils';

/**
 * `chainLength` → `Chain length`, `statusCode` → `Status code`.
 * Evidence keys are written by the rules in camelCase; readers are not.
 */
function humaniseKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/** Arrays longer than this are cut off — evidence can hold every affected URL on a site. */
const MAX_ITEMS = 25;
const MAX_DEPTH = 3;

function ScalarValue({ value }: { value: string | number | boolean | null }): React.JSX.Element {
  if (value === null) return <span className="text-muted-foreground">null</span>;
  if (typeof value === 'boolean') {
    return <span className={value ? 'text-success' : 'text-muted-foreground'}>{value ? 'Yes' : 'No'}</span>;
  }
  if (typeof value === 'number') {
    return <span className="tabular text-foreground">{value.toLocaleString('en-US')}</span>;
  }
  if (isUrl(value)) {
    return (
      <a
        href={value}
        target="_blank"
        rel="noopener noreferrer"
        className="break-all font-mono text-2xs text-primary underline-offset-4 hover:underline"
      >
        {value}
      </a>
    );
  }
  return <span className="break-words text-foreground">{value}</span>;
}

function EvidenceValue({ value, depth }: { value: unknown; depth: number }): React.JSX.Element {
  if (value === null || value === undefined) return <ScalarValue value={null} />;

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return <ScalarValue value={value} />;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-muted-foreground">None</span>;
    const shown = value.slice(0, MAX_ITEMS);
    return (
      <ul className="space-y-0.5">
        {shown.map((item, index) => (
          <li key={index} className="flex gap-1.5">
            <span aria-hidden="true" className="tabular shrink-0 text-muted-foreground">
              {index + 1}.
            </span>
            <span className="min-w-0">
              <EvidenceValue value={item} depth={depth + 1} />
            </span>
          </li>
        ))}
        {value.length > shown.length ? (
          <li className="text-muted-foreground">
            +{value.length - shown.length} more (see the raw JSON below)
          </li>
        ) : null}
      </ul>
    );
  }

  if (typeof value === 'object') {
    if (depth >= MAX_DEPTH) {
      return <span className="break-all font-mono text-2xs text-muted-foreground">{safeStringify(value)}</span>;
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <span className="text-muted-foreground">None</span>;
    return <EvidenceList entries={entries} depth={depth} />;
  }

  return <span className="text-muted-foreground">—</span>;
}

function EvidenceList({
  entries,
  depth,
}: {
  entries: Array<[string, unknown]>;
  depth: number;
}): React.JSX.Element {
  return (
    <dl className={cn('space-y-1.5', depth > 0 && 'border-l border-border pl-3')}>
      {entries.map(([key, value]) => (
        <div key={key} className="grid gap-0.5 sm:grid-cols-[minmax(6rem,10rem)_minmax(0,1fr)] sm:gap-3">
          <dt className="text-2xs font-medium text-muted-foreground">{humaniseKey(key)}</dt>
          <dd className="min-w-0 text-2xs leading-relaxed">
            <EvidenceValue value={value} depth={depth + 1} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Never throws on a cycle or a BigInt — evidence is arbitrary JSON from the rules. */
function safeStringify(value: unknown, space = 2): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(
      value,
      (_key, entry: unknown) => {
        if (typeof entry === 'bigint') return entry.toString();
        if (typeof entry === 'object' && entry !== null) {
          if (seen.has(entry)) return '[circular]';
          seen.add(entry);
        }
        return entry;
      },
      space,
    ) ?? String(value);
  } catch {
    return String(value);
  }
}

export interface EvidenceBlockProps {
  /** The rule's `evidence` JSON, exactly as it was stored. */
  evidence: unknown;
}

/**
 * The evidence a rule recorded when it raised the issue, rendered as labelled values rather than
 * a wall of JSON — while still offering the raw object, because the people who ask for evidence
 * are usually the ones who want to paste it into a ticket.
 */
export function EvidenceBlock({ evidence }: EvidenceBlockProps): React.JSX.Element {
  const isEmptyObject =
    evidence !== null &&
    typeof evidence === 'object' &&
    !Array.isArray(evidence) &&
    Object.keys(evidence as Record<string, unknown>).length === 0;

  if (evidence === null || evidence === undefined || isEmptyObject) {
    return (
      <p className="text-2xs leading-relaxed text-muted-foreground">
        This rule recorded no structured evidence — the description above is everything it observed.
      </p>
    );
  }

  const raw = safeStringify(evidence);

  return (
    <div className="space-y-2">
      <div className="rounded-md border border-border bg-muted/30 p-3">
        <EvidenceValue value={evidence} depth={0} />
      </div>

      <details className="group">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-2xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <span className="group-open:hidden">Show raw JSON</span>
          <span className="hidden group-open:inline">Hide raw JSON</span>
        </summary>
        <div className="mt-1.5 space-y-1.5">
          <pre className="max-h-64 overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-2xs leading-relaxed text-foreground">
            {raw}
          </pre>
          <CopyButton value={raw} label="Copy evidence JSON" showLabel size="sm" />
        </div>
      </details>
    </div>
  );
}
