'use client';

import { AlertTriangle, CircleAlert, CircleCheck } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { CopyButton } from '@/components/ui/copy-button';
import { cn } from '@/lib/utils';
import { countErrors, formatJsonLd, scriptTag, type SchemaIssue } from './types';

/**
 * Pretty-printed JSON-LD with the two things an operator actually leaves with: the block itself,
 * and the exact `<script>` tag to paste into a template. The tag is shown in full rather than
 * described, because "wrap it in a script tag" is where hand-deployed markup goes wrong.
 */
export function JsonLdBlock({
  jsonLd,
  label = 'JSON-LD',
  emptyMessage = 'This row holds no parseable JSON-LD.',
  maxHeight = 340,
  className,
}: {
  jsonLd: unknown;
  label?: string;
  emptyMessage?: string;
  maxHeight?: number;
  className?: string;
}): React.JSX.Element {
  const json = formatJsonLd(jsonLd);
  const tag = scriptTag(jsonLd);

  if (json.length === 0) {
    return (
      <p className={cn('rounded-md border border-border bg-muted/40 px-3 py-2.5 text-sm text-muted-foreground', className)}>
        {emptyMessage}
      </p>
    );
  }

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <div className="flex items-center gap-1">
          <CopyButton value={json} label="Copy JSON-LD" size="sm" showLabel />
          <CopyButton
            value={tag}
            label="Copy <script> tag"
            copiedLabel="Tag copied"
            size="sm"
            variant="outline"
            showLabel
          />
        </div>
      </div>
      <pre
        className="overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-2xs leading-relaxed text-foreground"
        style={{ maxHeight }}
      >
        <code>{json}</code>
      </pre>
    </div>
  );
}

/** The literal tag, so what is copied is also what is read. */
export function ScriptTagBlock({ jsonLd }: { jsonLd: unknown }): React.JSX.Element | null {
  const tag = scriptTag(jsonLd);
  if (tag.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">Paste this into the page&rsquo;s HTML</span>
        <CopyButton value={tag} label="Copy tag" size="sm" showLabel />
      </div>
      <pre className="overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-2xs leading-relaxed text-foreground">
        <code>{tag}</code>
      </pre>
      <p className="text-2xs text-muted-foreground">
        Anywhere in <code className="font-mono">&lt;head&gt;</code> or <code className="font-mono">&lt;body&gt;</code>{' '}
        works. Search engines read the tag wherever it sits, as long as it is in the HTML the crawler receives
        rather than injected later by client-side JavaScript.
      </p>
    </div>
  );
}

/**
 * The specific errors, not a count. "Invalid" on its own tells an operator nothing they can act
 * on; `$.mainEntity — FAQPage requires "mainEntity"` tells them exactly what to add.
 */
export function IssueList({
  issues,
  emptyMessage = 'No issues found.',
  className,
}: {
  issues: readonly SchemaIssue[];
  emptyMessage?: string;
  className?: string;
}): React.JSX.Element {
  if (issues.length === 0) {
    return (
      <p className={cn('flex items-center gap-1.5 text-sm text-muted-foreground', className)}>
        <CircleCheck className="size-3.5 text-success" aria-hidden="true" />
        {emptyMessage}
      </p>
    );
  }

  const errors = countErrors(issues);

  return (
    <div className={cn('space-y-2', className)}>
      <p className="text-xs text-muted-foreground">
        {errors > 0
          ? `${errors} error${errors === 1 ? '' : 's'} block rich results.`
          : 'Warnings only — the markup is eligible, but incomplete.'}{' '}
        {issues.length - errors > 0
          ? `${issues.length - errors} recommendation${issues.length - errors === 1 ? '' : 's'}.`
          : null}
      </p>
      <ul className="space-y-1.5">
        {issues.map((issue, index) => (
          <li
            key={`${issue.path}-${index}`}
            className={cn(
              'flex gap-2 rounded-md border px-2.5 py-2 text-xs',
              issue.severity === 'error'
                ? 'border-destructive/25 bg-destructive/[0.06]'
                : 'border-warning/25 bg-warning/[0.06]',
            )}
          >
            {issue.severity === 'error' ? (
              <CircleAlert className="mt-px size-3.5 shrink-0 text-destructive" aria-hidden="true" />
            ) : (
              <AlertTriangle className="mt-px size-3.5 shrink-0 text-warning" aria-hidden="true" />
            )}
            <div className="min-w-0 space-y-0.5">
              <p className="font-mono text-2xs text-muted-foreground">{issue.path}</p>
              <p className="text-foreground">{issue.message}</p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Shared tone mapping so a status reads the same in the table, the sheet and the validator. */
export function ValidationBadge({
  status,
  errorCount,
}: {
  status: 'VALID' | 'WARNING' | 'INVALID' | 'UNVALIDATED';
  errorCount?: number;
}): React.JSX.Element {
  switch (status) {
    case 'VALID':
      return <Badge variant="success">Valid</Badge>;
    case 'WARNING':
      return <Badge variant="warning">Warnings</Badge>;
    case 'INVALID':
      return (
        <Badge variant="destructive">
          {errorCount && errorCount > 0 ? `${errorCount} error${errorCount === 1 ? '' : 's'}` : 'Invalid'}
        </Badge>
      );
    default:
      return <Badge variant="muted">Not validated</Badge>;
  }
}
