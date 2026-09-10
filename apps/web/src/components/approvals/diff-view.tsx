import * as React from 'react';
import { ArrowRight, Braces, Link2, Signpost } from 'lucide-react';

import { SEO_THRESHOLDS } from '@seo/shared/constants';

import { Badge } from '@/components/ui/badge';
import { CopyButton } from '@/components/ui/copy-button';
import { cn } from '@/lib/utils';
import { humanizeKey, JsonView, hasJsonContent } from '@/components/actions/json-view';
import { diffStats, diffWords } from './word-diff';

/**
 * The visual half of the approval diff.
 *
 * Everything here renders values that are actually stored on the approval — the agent's field
 * diff, and the payload it will apply. Nothing is derived or predicted: an approval whose agent
 * wrote no diff says so rather than showing an empty green block.
 */

// ── inline word diff ─────────────────────────────────────────

export interface DiffTextProps {
  before: string;
  after: string;
  className?: string;
}

/** Real `<ins>`/`<del>` elements so the change survives copy-paste and reaches assistive tech. */
export function DiffText({ before, after, className }: DiffTextProps): React.JSX.Element {
  const pieces = diffWords(before, after);

  return (
    <p className={cn('whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground', className)}>
      {pieces.map((piece, index) => {
        if (piece.op === 'equal') return <React.Fragment key={index}>{piece.text}</React.Fragment>;
        if (piece.op === 'insert') {
          return (
            <ins
              key={index}
              className="rounded-sm bg-success/15 px-0.5 text-success no-underline decoration-success/40"
            >
              {piece.text}
            </ins>
          );
        }
        return (
          <del key={index} className="rounded-sm bg-destructive/15 px-0.5 text-destructive">
            {piece.text}
          </del>
        );
      })}
    </p>
  );
}

// ── one field ────────────────────────────────────────────────

/** Fields whose length is itself an SEO signal, so the character count is worth showing. */
const LENGTH_LIMITS: Record<string, { min: number; max: number }> = {
  title: SEO_THRESHOLDS.title,
  metaTitle: SEO_THRESHOLDS.title,
  metaDescription: SEO_THRESHOLDS.metaDescription,
};

function LengthNote({ field, value }: { field: string; value: string | null }): React.JSX.Element | null {
  const limits = LENGTH_LIMITS[field];
  if (!limits || value === null) return null;

  const length = value.length;
  const within = length >= limits.min && length <= limits.max;
  return (
    <span
      className={cn('tabular text-2xs', within ? 'text-muted-foreground' : 'text-warning')}
      title={`Recommended ${limits.min}–${limits.max} characters`}
    >
      {length} chars
    </span>
  );
}

export interface FieldDiffProps {
  field: string;
  before: string | null;
  after: string | null;
}

export function FieldDiff({ field, before, after }: FieldDiffProps): React.JSX.Element {
  const beforeText = before ?? '';
  const afterText = after ?? '';
  const stats = diffStats(diffWords(beforeText, afterText));

  return (
    <div className="space-y-1.5 rounded-md border border-border bg-background/60 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-xs font-medium text-foreground">{humanizeKey(field)}</span>
        <span className="flex items-center gap-2">
          <LengthNote field={field} value={after} />
          {stats.identical ? (
            <span className="text-2xs text-muted-foreground">No change</span>
          ) : (
            <span className="tabular text-2xs">
              {stats.added > 0 ? <span className="text-success">+{stats.added}</span> : null}
              {stats.added > 0 && stats.removed > 0 ? <span className="text-muted-foreground"> / </span> : null}
              {stats.removed > 0 ? <span className="text-destructive">−{stats.removed}</span> : null}
              <span className="text-muted-foreground"> words</span>
            </span>
          )}
        </span>
      </div>

      {before === null && after !== null ? (
        <p className="text-2xs text-muted-foreground">This field is empty today and will be set.</p>
      ) : null}
      {before !== null && after === null ? (
        <p className="text-2xs text-warning">This field will be cleared.</p>
      ) : null}

      <DiffText before={beforeText} after={afterText} />
    </div>
  );
}

// ── payload highlights ───────────────────────────────────────

interface LinkInsertion {
  anchor: string;
  href: string;
  title?: string;
}

function readLinks(value: unknown): LinkInsertion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.anchor !== 'string' || typeof record.href !== 'string') return [];
    return [
      {
        anchor: record.anchor,
        href: record.href,
        ...(typeof record.title === 'string' ? { title: record.title } : {}),
      },
    ];
  });
}

/** Payload keys rendered by a dedicated block above, so the JSON fallback does not repeat them. */
const HANDLED_KEYS = new Set([
  'links',
  'structuredData',
  'jsonLd',
  'schema',
  'from',
  'to',
  'redirectType',
  'title',
  'metaTitle',
  'metaDescription',
  'bodyHtml',
  'bodyMarkdown',
  'excerpt',
  'slug',
  'canonicalUrl',
]);

function Block({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="space-y-1.5 rounded-md border border-border bg-background/60 p-3">
      <p className="flex items-center gap-1.5 text-xs font-medium text-foreground">
        <Icon className="size-3.5 text-muted-foreground" aria-hidden />
        {title}
      </p>
      {children}
    </div>
  );
}

export interface PayloadHighlightsProps {
  payload: Record<string, unknown>;
}

/**
 * The parts of an apply payload that are a change in their own right rather than a field edit:
 * the internal links to insert, the JSON-LD to add, the redirect to create.
 */
export function PayloadHighlights({ payload }: PayloadHighlightsProps): React.JSX.Element | null {
  const links = readLinks(payload.links);
  const structuredData = payload.structuredData ?? payload.jsonLd ?? payload.schema ?? null;
  const redirectFrom = typeof payload.from === 'string' ? payload.from : null;
  const redirectTo = typeof payload.to === 'string' ? payload.to : null;
  const redirectType = typeof payload.redirectType === 'string' ? payload.redirectType : null;

  const rest = Object.fromEntries(
    Object.entries(payload).filter(([key, value]) => !HANDLED_KEYS.has(key) && hasJsonContent(value)),
  );

  const hasRedirect = redirectFrom !== null && redirectTo !== null;
  const hasStructuredData = structuredData !== null && hasJsonContent(structuredData);
  const hasRest = Object.keys(rest).length > 0;

  if (links.length === 0 && !hasStructuredData && !hasRedirect && !hasRest) return null;

  const structuredDataJson = hasStructuredData ? JSON.stringify(structuredData, null, 2) : '';

  return (
    <div className="space-y-2">
      {links.length > 0 ? (
        <Block icon={Link2} title={`${links.length} internal link${links.length === 1 ? '' : 's'} to insert`}>
          <ul className="space-y-1">
            {links.map((link, index) => (
              <li key={`${link.href}-${index}`} className="flex flex-wrap items-baseline gap-1.5 text-xs">
                <span className="rounded-sm bg-success/15 px-1 py-0.5 text-success">{link.anchor}</span>
                <ArrowRight className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                <a
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="break-all font-mono text-2xs text-primary underline-offset-4 hover:underline"
                >
                  {link.href}
                </a>
                {link.title ? <span className="text-2xs text-muted-foreground">({link.title})</span> : null}
              </li>
            ))}
          </ul>
        </Block>
      ) : null}

      {hasStructuredData ? (
        <Block icon={Braces} title="JSON-LD to add">
          <div className="flex items-start gap-2">
            <pre className="max-h-64 min-w-0 flex-1 overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-2xs leading-relaxed text-foreground">
              {structuredDataJson}
            </pre>
            <CopyButton value={structuredDataJson} label="Copy the JSON-LD" className="shrink-0" />
          </div>
        </Block>
      ) : null}

      {hasRedirect ? (
        <Block icon={Signpost} title="Redirect to create">
          <p className="flex flex-wrap items-center gap-1.5 font-mono text-2xs">
            <span className="break-all text-destructive">{redirectFrom}</span>
            <ArrowRight className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="break-all text-success">{redirectTo}</span>
            <Badge variant="outline" className="ml-1">
              {redirectType ?? 'PERMANENT'}
            </Badge>
          </p>
        </Block>
      ) : null}

      {hasRest ? (
        <details className="rounded-md border border-border bg-background/60 p-3">
          <summary className="cursor-pointer text-xs font-medium text-foreground">
            Rest of the payload ({Object.keys(rest).length} field
            {Object.keys(rest).length === 1 ? '' : 's'})
          </summary>
          <div className="mt-2">
            <JsonView value={rest} />
          </div>
        </details>
      ) : null}
    </div>
  );
}

// ── the whole diff for one approval ──────────────────────────

export interface ApprovalDiffEntryView {
  field: string;
  before: string | null;
  after: string | null;
}

export interface ApprovalDiffProps {
  entries: readonly ApprovalDiffEntryView[];
  /** The agent's raw diff JSON, shown when it is not in a shape the normaliser understands. */
  rawDiff: unknown;
  /** `editedPayload` when the operator changed it, else the agent's own payload. */
  payload: Record<string, unknown>;
  edited: boolean;
}

export function ApprovalDiff({ entries, rawDiff, payload, edited }: ApprovalDiffProps): React.JSX.Element {
  const highlights = <PayloadHighlights payload={payload} />;
  const showRaw = entries.length === 0 && hasJsonContent(rawDiff);
  const nothing = entries.length === 0 && highlights === null && !showRaw;

  return (
    <div className="space-y-2">
      {edited ? (
        <p className="rounded-md border border-info/25 bg-info/[0.07] px-2.5 py-1.5 text-2xs text-foreground">
          Showing the edited payload. Approving applies these values, not the agent&apos;s original
          proposal.
        </p>
      ) : null}

      {entries.map((entry) => (
        <FieldDiff key={entry.field} field={entry.field} before={entry.before} after={entry.after} />
      ))}

      {highlights}

      {showRaw ? (
        <div className="space-y-1.5 rounded-md border border-border bg-background/60 p-3">
          <p className="text-xs font-medium text-foreground">Recorded change</p>
          <p className="text-2xs text-muted-foreground">
            The agent stored this in a shape the field-diff viewer does not recognise, so it is
            shown exactly as written.
          </p>
          <JsonView value={rawDiff} />
        </div>
      ) : null}

      {nothing ? (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          No diff was recorded for this item. Open the action to see the evidence behind it before
          you decide.
        </p>
      ) : null}
    </div>
  );
}
