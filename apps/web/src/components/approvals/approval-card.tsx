'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Check,
  ChevronDown,
  ExternalLink,
  Globe,
  Lock,
  Pencil,
  ThumbsDown,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FormField } from '@/components/ui/form-field';
import { Textarea } from '@/components/ui/textarea';
import { TooltipInfo } from '@/components/ui/tooltip-info';
import { ApiError, apiPost } from '@/lib/api-client';
import { cn, shortenUrl } from '@/lib/utils';

import { summariseChange, summaryChips } from './change-summary';
import { ApprovalDiff, type ApprovalDiffEntryView } from './diff-view';
import { humanizeKind, riskMeta } from './meta';
import { PayloadEditor } from './payload-editor';
import type { ApprovalItem } from './types';

/**
 * One item in the approval queue.
 *
 * The card is built around the diff, because the only question it exists to answer is "what
 * exactly will change on the live site". Everything else — the site, the risk band, the agent's
 * reasoning — is context for that one decision, and the decision controls sit under the diff
 * rather than above it so they cannot be reached without scrolling past what they apply.
 */

const DATE_TIME = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});

/** Identical on the server and in the browser — a locale-sensitive format would fail hydration. */
function formatWhen(value: string | null): string {
  if (value === null) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '—' : DATE_TIME.format(parsed);
}

/** Reflect a string edit back into the diff so the "after" side is what will actually be applied. */
function applyEdits(
  entries: readonly ApprovalDiffEntryView[],
  payload: Record<string, unknown>,
): ApprovalDiffEntryView[] {
  return entries.map((entry) => {
    const value = payload[entry.field];
    return typeof value === 'string' ? { ...entry, after: value } : entry;
  });
}

export interface ApprovalCardProps {
  item: ApprovalItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** This is the item `?focus=` named: scroll to it and put the keyboard on it. */
  focused?: boolean;
}

export function ApprovalCard({
  item,
  open,
  onOpenChange,
  focused = false,
}: ApprovalCardProps): React.JSX.Element {
  const router = useRouter();
  const meta = riskMeta(item.risk);
  const RiskIcon = meta.icon;

  const articleRef = React.useRef<HTMLElement>(null);
  const [pending, setPending] = React.useState(false);
  const [rejectOpen, setRejectOpen] = React.useState(false);
  const [editorOpen, setEditorOpen] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const [draftPayload, setDraftPayload] = React.useState<Record<string, unknown> | null>(null);

  const bodyId = `approval-body-${item.id}`;
  const titleId = `approval-title-${item.id}`;
  const decided = item.status !== 'PENDING';

  // What approving would apply: the operator's unsaved edit, then a stored edit, then the agent's.
  const effectivePayload = draftPayload ?? item.editedPayload ?? item.payload;
  const edited = draftPayload !== null || item.editedPayload !== null;
  const entries = React.useMemo(
    () => (edited ? applyEdits(item.diff, effectivePayload) : item.diff),
    [edited, item.diff, effectivePayload],
  );
  const summary = React.useMemo(
    () => summariseChange(entries, effectivePayload),
    [entries, effectivePayload],
  );
  const chips = React.useMemo(() => summaryChips(summary), [summary]);

  React.useEffect(() => {
    if (!focused) return;
    const node = articleRef.current;
    if (!node) return;
    node.scrollIntoView({ block: 'start', behavior: 'smooth' });
    node.focus({ preventScroll: true });
  }, [focused]);

  const decide = async (
    decision: 'APPROVE' | 'REJECT',
    options: { note?: string; editedPayload?: Record<string, unknown> } = {},
  ): Promise<void> => {
    setPending(true);
    try {
      const result = await apiPost<{ job: { enqueued: boolean; message: string } | null }>(
        `/api/approvals/${item.id}/decide`,
        {
          decision,
          ...(options.note ? { note: options.note } : {}),
          ...(options.editedPayload ? { editedPayload: options.editedPayload } : {}),
        },
      );

      if (decision === 'REJECT') {
        toast.success('Rejected', {
          description: 'The note is stored on the approval and the action is closed.',
        });
      } else if (result.job === null) {
        toast.success('Approved', {
          description: 'This approval has no action behind it, so nothing was queued.',
        });
      } else if (result.job.enqueued) {
        toast.success('Approved and queued', {
          description: 'The executor applies the change and records a rollback point.',
        });
      } else {
        toast.warning('Approved, but nothing picked it up', {
          description: `${result.job.message} Start the worker (npm run dev:worker) or check REDIS_URL.`,
        });
      }

      setRejectOpen(false);
      setEditorOpen(false);
      setReason('');
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not record that decision');
    } finally {
      setPending(false);
    }
  };

  return (
    <Card
      className={cn(
        'overflow-hidden transition-shadow',
        focused && 'ring-2 ring-ring ring-offset-2 ring-offset-background',
        decided && 'opacity-90',
      )}
    >
      <article
        ref={articleRef}
        id={`approval-${item.id}`}
        tabIndex={-1}
        aria-labelledby={titleId}
        className="scroll-mt-24 focus:outline-none"
      >
        {/* Header */}
        <div className="flex flex-col gap-2 p-4">
          <div className="flex flex-wrap items-center gap-1.5">
            <Link
              href={`/sites/${item.websiteId}`}
              className="inline-flex max-w-[16rem] items-center gap-1 truncate rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-2xs font-medium text-foreground transition-colors hover:bg-accent"
            >
              <Globe className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="truncate">{item.websiteName}</span>
              <span className="sr-only"> — open this website</span>
            </Link>
            <Badge variant={meta.tone}>
              <RiskIcon className="size-3" aria-hidden="true" />
              {meta.label}
            </Badge>
            <Badge variant="outline">{humanizeKind(item.kind)}</Badge>
            {decided ? <StatusBadge status={item.status} /> : null}
            {item.requiresIndividualDecision ? (
              <Badge variant="muted">
                <Lock className="size-3" aria-hidden="true" />
                Individual decision only
              </Badge>
            ) : null}
            {item.action ? (
              <span className="tabular ml-auto inline-flex items-center gap-1 text-2xs text-muted-foreground">
                Priority {Math.round(item.action.priorityScore)}
                <TooltipInfo
                  label="How the priority score is built"
                  content="The action's own 0-100 priority: expected impact and business value, divided by effort and risk, scaled by confidence. Open the action to see the exact factor weights that produced it."
                />
              </span>
            ) : null}
            <span
              className={cn('text-2xs text-muted-foreground', item.action ? '' : 'ml-auto')}
            >
              Raised {formatWhen(item.createdAt)} UTC
            </span>
          </div>

          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
            <div className="min-w-0 flex-1 space-y-1">
              <h3
                id={titleId}
                className="text-sm font-semibold leading-snug tracking-tight text-foreground"
              >
                {item.title}
              </h3>
              {item.description ? (
                <p className="text-xs leading-relaxed text-muted-foreground">{item.description}</p>
              ) : null}
            </div>

            <Button
              variant="ghost"
              size="sm"
              aria-expanded={open}
              aria-controls={bodyId}
              onClick={() => onOpenChange(!open)}
            >
              <ChevronDown
                className={cn('transition-transform', open && 'rotate-180')}
                aria-hidden="true"
              />
              {open ? 'Hide the diff' : 'Show the diff'}
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {chips.length > 0 ? (
              chips.map((chip) => (
                <span
                  key={chip}
                  className="tabular rounded-md bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground"
                >
                  {chip}
                </span>
              ))
            ) : (
              <span className="text-2xs text-muted-foreground">
                No field-level diff was recorded — open it to see what the agent stored.
              </span>
            )}
            {edited ? (
              <Badge variant="info">
                <Pencil className="size-3" aria-hidden="true" />
                Edited
              </Badge>
            ) : null}
          </div>
        </div>

        {/* Body */}
        <div id={bodyId} hidden={!open} className="border-t border-border bg-muted/20 p-4">
          <div className="space-y-3">
            {item.action ? (
              <div className="space-y-1.5 rounded-md border border-border bg-background/60 p-3">
                <p className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-foreground">
                  Why the agent proposed this
                  <TooltipInfo
                    label="Where this reasoning comes from"
                    content="Written by the agent that raised the action, stored on the action record. It is not regenerated for this screen."
                  />
                </p>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {item.action.reasoning}
                </p>
                {item.action.affectedUrls.length > 0 ? (
                  <ul className="space-y-0.5 pt-1">
                    {item.action.affectedUrls.slice(0, 6).map((url) => (
                      <li key={url}>
                        <a
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex max-w-full items-center gap-1 truncate font-mono text-2xs text-primary underline-offset-4 hover:underline"
                        >
                          {shortenUrl(url, 72)}
                          <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
                        </a>
                      </li>
                    ))}
                    {item.action.affectedUrls.length > 6 ? (
                      <li className="text-2xs text-muted-foreground">
                        and {item.action.affectedUrls.length - 6} more URLs
                      </li>
                    ) : null}
                  </ul>
                ) : null}
              </div>
            ) : null}

            <ApprovalDiff
              entries={entries}
              rawDiff={item.rawDiff}
              payload={effectivePayload}
              edited={edited}
            />

            {decided ? (
              <div className="rounded-md border border-border bg-background/60 p-3 text-xs">
                <p className="font-medium text-foreground">
                  {item.status === 'APPROVED' ? 'Approved' : 'Rejected'}
                  {item.decidedBy ? ` by ${item.decidedBy}` : ''} · {formatWhen(item.decidedAt)} UTC
                </p>
                {item.decisionNote ? (
                  <p className="mt-1 leading-relaxed text-muted-foreground">{item.decisionNote}</p>
                ) : (
                  <p className="mt-1 text-muted-foreground">No note was recorded.</p>
                )}
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
                <Button
                  size="sm"
                  onClick={() =>
                    void decide('APPROVE', draftPayload ? { editedPayload: draftPayload } : {})
                  }
                  loading={pending}
                  loadingText="Approving"
                >
                  <Check aria-hidden="true" />
                  {edited ? 'Approve the edited change' : 'Approve'}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => setEditorOpen(true)}
                >
                  <Pencil aria-hidden="true" />
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => setRejectOpen(true)}
                >
                  <ThumbsDown aria-hidden="true" />
                  Reject
                </Button>
                {draftPayload !== null ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => setDraftPayload(null)}
                  >
                    <X aria-hidden="true" />
                    Discard my edit
                  </Button>
                ) : null}
                {item.actionId ? (
                  <Button asChild size="sm" variant="ghost" className="ml-auto">
                    <Link href={`/actions/${item.actionId}`}>Open the action</Link>
                  </Button>
                ) : null}
              </div>
            )}
          </div>
        </div>
      </article>

      {/* Reject */}
      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject this change</DialogTitle>
            <DialogDescription>{item.title}</DialogDescription>
          </DialogHeader>

          <FormField
            label="Why are you rejecting it?"
            required
            description="Stored on the approval and on the action. It is the only record of why a proposed change was not made, so write it for whoever reads the history next."
          >
            <Textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={4}
              maxLength={1000}
              placeholder="e.g. the rewritten title drops the product name we rank for"
            />
          </FormField>

          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={reason.trim().length === 0}
              onClick={() => void decide('REJECT', { note: reason.trim() })}
              loading={pending}
              loadingText="Rejecting"
            >
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PayloadEditor
        open={editorOpen}
        onOpenChange={setEditorOpen}
        title={item.title}
        payload={effectivePayload}
        originalPayload={item.payload}
        pending={pending}
        onSave={(next) => {
          setDraftPayload(next);
          setEditorOpen(false);
          onOpenChange(true);
          toast.success('Edit saved to this card', {
            description: 'The diff now shows your values. Nothing is applied until you approve.',
          });
        }}
        onSaveAndApprove={(next) => {
          setDraftPayload(next);
          void decide('APPROVE', { editedPayload: next });
        }}
      />
    </Card>
  );
}
