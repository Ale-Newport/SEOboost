'use client';

import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MessageSquarePlus, Pencil, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { TooltipInfo } from '@/components/ui/tooltip-info';
import { DataTable, type ColumnDef } from '@/components/data/data-table';
import { ApiError, apiPost } from '@/lib/api-client';
import { formatNumber, formatPercent } from '@/lib/utils';
import type { AiVisibilityPromptRow } from '@/server/queries/ai-visibility';

/**
 * The tracked prompt set: what we ask assistants about this brand.
 *
 * Every mutation goes through `POST /api/ai-visibility/prompts`, whose `op` discriminator keeps
 * add / update / toggle / remove atomic from the client's point of view. Rates shown per prompt
 * are the stored rolling values recomputed from every run — a prompt that has never run shows
 * "Not measured" rather than 0%, because those are different facts.
 */

function messageOf(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

function rateCell(value: number | null): React.JSX.Element {
  if (value === null) return <span className="text-muted-foreground">Not measured</span>;
  return <span className="tabular">{formatPercent(value, 0)}</span>;
}

function whenCell(value: Date | null): React.JSX.Element {
  if (value === null) return <span className="text-muted-foreground">Never run</span>;
  return (
    <time dateTime={value.toISOString()} className="tabular text-xs">
      {value.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}
    </time>
  );
}

export function PromptManager({
  websiteId,
  brandName,
  prompts,
}: {
  websiteId: string;
  brandName: string;
  prompts: readonly AiVisibilityPromptRow[];
}): React.JSX.Element {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<AiVisibilityPromptRow | null>(null);
  const [removing, setRemoving] = useState<AiVisibilityPromptRow | null>(null);
  const [pendingIds, setPendingIds] = useState<readonly string[]>([]);

  const toggle = useCallback(
    async (prompt: AiVisibilityPromptRow, isActive: boolean) => {
      setPendingIds((current) => [...current, prompt.id]);
      try {
        await apiPost('/api/ai-visibility/prompts', {
          op: 'toggle',
          websiteId,
          id: prompt.id,
          isActive,
        });
        toast.success(isActive ? 'Prompt activated' : 'Prompt paused', {
          description: isActive
            ? 'It will be included the next time the prompt set is run.'
            : 'It stays in the list and keeps its history, but will not be run.',
        });
        router.refresh();
      } catch (error) {
        toast.error(messageOf(error, 'Could not change this prompt.'));
      } finally {
        setPendingIds((current) => current.filter((id) => id !== prompt.id));
      }
    },
    [websiteId, router],
  );

  const remove = useCallback(async () => {
    if (!removing) return;
    await apiPost('/api/ai-visibility/prompts', { op: 'remove', websiteId, id: removing.id });
    toast.success('Prompt removed', { description: 'Its recorded runs are removed with it.' });
    setRemoving(null);
    router.refresh();
  }, [removing, websiteId, router]);

  const columns = useMemo<Array<ColumnDef<AiVisibilityPromptRow>>>(
    () => [
      {
        id: 'prompt',
        header: 'Prompt',
        accessor: (row) => row.prompt,
        cell: (row) => (
          <div className="min-w-0 space-y-1">
            <p className="line-clamp-2 text-xs leading-relaxed text-foreground">{row.prompt}</p>
            <div className="flex flex-wrap items-center gap-1">
              {row.category ? <Badge variant="outline">{row.category}</Badge> : null}
              <Badge variant="muted">{row.source === 'manual' ? 'Added by you' : 'Discovered'}</Badge>
              <span className="text-2xs text-muted-foreground">{row.locale}</span>
            </div>
          </div>
        ),
        sortable: true,
        width: 380,
        sticky: true,
      },
      {
        id: 'isActive',
        header: 'Active',
        accessor: (row) => (row.isActive ? 1 : 0),
        cell: (row) => (
          <Switch
            checked={row.isActive}
            disabled={pendingIds.includes(row.id)}
            onCheckedChange={(checked) => void toggle(row, checked)}
            aria-label={`${row.isActive ? 'Pause' : 'Activate'} the prompt “${row.prompt}”`}
          />
        ),
        exportValue: (row) => (row.isActive ? 'active' : 'paused'),
        sortable: true,
        width: 90,
      },
      {
        id: 'priority',
        header: 'Priority',
        accessor: (row) => row.priority,
        cell: (row) => <span className="tabular">{row.priority}</span>,
        sortable: true,
        align: 'right',
        width: 96,
      },
      {
        id: 'lastRunAt',
        header: 'Last run',
        accessor: (row) => row.lastRunAt,
        cell: (row) => whenCell(row.lastRunAt),
        sortable: true,
        width: 130,
      },
      {
        id: 'runCount',
        header: 'Runs',
        accessor: (row) => row.runCount,
        cell: (row) => <span className="tabular">{formatNumber(row.runCount)}</span>,
        sortable: true,
        align: 'right',
        width: 84,
      },
      {
        id: 'mentionRate',
        header: 'Mention rate',
        accessor: (row) => row.mentionRate,
        cell: (row) => rateCell(row.mentionRate),
        sortable: true,
        align: 'right',
        width: 130,
      },
      {
        id: 'citationRate',
        header: 'Citation rate',
        accessor: (row) => row.citationRate,
        cell: (row) => rateCell(row.citationRate),
        sortable: true,
        align: 'right',
        width: 130,
      },
      {
        id: 'actions',
        header: '',
        headerLabel: 'Actions',
        accessor: () => '',
        cell: (row) => (
          <div className="flex items-center justify-end gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="size-8 px-0"
              onClick={() => setEditing(row)}
              aria-label={`Edit the prompt “${row.prompt}”`}
            >
              <Pencil aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="size-8 px-0"
              onClick={() => setRemoving(row)}
              aria-label={`Remove the prompt “${row.prompt}”`}
            >
              <Trash2 aria-hidden="true" />
            </Button>
          </div>
        ),
        align: 'right',
        width: 90,
      },
    ],
    [pendingIds, toggle],
  );

  return (
    <>
      <DataTable
        data={prompts}
        columns={columns}
        getRowId={(row) => row.id}
        caption="Prompts tracked against AI assistants for this website"
        searchable
        searchPlaceholder="Search prompts…"
        searchKeys={['prompt']}
        defaultSort="priority"
        defaultOrder="desc"
        itemLabel="prompts"
        exportFilename="ai-visibility-prompts"
        stickyHeader
        maxHeight={560}
        emptyTitle="No prompts are tracked yet"
        emptyDescription="Add the questions a buyer would actually ask an assistant, or run discovery to propose a starting set from this site's keywords."
        toolbarActions={
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <MessageSquarePlus aria-hidden="true" />
            Add prompt
          </Button>
        }
      />

      <AddPromptDialog
        open={adding}
        onOpenChange={setAdding}
        websiteId={websiteId}
        brandName={brandName}
      />

      <EditPromptDialog
        prompt={editing}
        onOpenChange={(open) => setEditing(open ? editing : null)}
        websiteId={websiteId}
        brandName={brandName}
      />

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => setRemoving(open ? removing : null)}
        title="Remove this prompt?"
        description={
          removing
            ? `“${removing.prompt}” and its ${formatNumber(removing.runCount)} recorded run(s) will be deleted. Pausing keeps the history instead.`
            : undefined
        }
        confirmLabel="Remove prompt"
        destructive
        onConfirm={remove}
      />
    </>
  );
}

function AddPromptDialog({
  open,
  onOpenChange,
  websiteId,
  brandName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  websiteId: string;
  brandName: string;
}): React.JSX.Element {
  const router = useRouter();
  const [prompt, setPrompt] = useState('');
  const [category, setCategory] = useState('');
  const [locale, setLocale] = useState('en-US');
  const [priority, setPriority] = useState('50');
  const [expectedBrand, setExpectedBrand] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (pending) return;
      setPending(true);
      setError(null);
      try {
        await apiPost('/api/ai-visibility/prompts', {
          op: 'add',
          websiteId,
          prompt: prompt.trim(),
          ...(category.trim() ? { category: category.trim() } : {}),
          locale: locale.trim() || 'en-US',
          priority: Number(priority),
          ...(expectedBrand.trim() ? { expectedBrand: expectedBrand.trim() } : {}),
        });
        toast.success('Prompt added', {
          description: 'It is measured from the next run onwards — no history is back-filled.',
        });
        setPrompt('');
        setCategory('');
        setExpectedBrand('');
        onOpenChange(false);
        router.refresh();
      } catch (cause) {
        setError(messageOf(cause, 'Could not add this prompt.'));
      } finally {
        setPending(false);
      }
    },
    [category, expectedBrand, locale, onOpenChange, pending, priority, prompt, router, websiteId],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Track a prompt</DialogTitle>
          <DialogDescription>
            Write it the way a buyer would ask an assistant — a real question, not a keyword. Each run
            records whether {brandName} was named and which of your URLs were cited.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          <FormField
            label="Prompt"
            required
            description="At least five characters. One question per prompt keeps the answer attributable."
            {...(error ? { error } : {})}
          >
            <Textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={3}
              required
              autoFocus
              placeholder="What is the best technical SEO platform for a mid-market SaaS company?"
            />
          </FormField>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Category" description="Optional grouping, e.g. “comparison” or “how-to”.">
              <Input
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                placeholder="comparison"
                autoComplete="off"
              />
            </FormField>

            <FormField label="Priority" description="0-100. Higher runs first when a run is capped.">
              <Input
                type="number"
                min={0}
                max={100}
                value={priority}
                onChange={(event) => setPriority(event.target.value)}
              />
            </FormField>

            <FormField label="Locale" description="BCP-47 tag. Answers differ by market.">
              <Input
                value={locale}
                onChange={(event) => setLocale(event.target.value)}
                placeholder="en-US"
                autoComplete="off"
              />
            </FormField>

            <FormField
              label="Expected brand"
              description={`The name to look for in the answer. Defaults to ${brandName}.`}
            >
              <Input
                value={expectedBrand}
                onChange={(event) => setExpectedBrand(event.target.value)}
                placeholder={brandName}
                autoComplete="off"
              />
            </FormField>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" loading={pending} loadingText="Saving">
              Add prompt
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditPromptDialog({
  prompt,
  onOpenChange,
  websiteId,
  brandName,
}: {
  prompt: AiVisibilityPromptRow | null;
  onOpenChange: (open: boolean) => void;
  websiteId: string;
  brandName: string;
}): React.JSX.Element {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!prompt || pending) return;
      const form = new FormData(event.currentTarget);
      const category = String(form.get('category') ?? '').trim();
      const expectedBrand = String(form.get('expectedBrand') ?? '').trim();
      const priority = Number(form.get('priority') ?? prompt.priority);

      setPending(true);
      setError(null);
      try {
        await apiPost('/api/ai-visibility/prompts', {
          op: 'update',
          websiteId,
          id: prompt.id,
          category: category.length > 0 ? category : null,
          expectedBrand: expectedBrand.length > 0 ? expectedBrand : null,
          priority,
        });
        toast.success('Prompt updated');
        onOpenChange(false);
        router.refresh();
      } catch (cause) {
        setError(messageOf(cause, 'Could not update this prompt.'));
      } finally {
        setPending(false);
      }
    },
    [onOpenChange, pending, prompt, router, websiteId],
  );

  return (
    <Dialog open={prompt !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        {prompt ? (
          <>
            <DialogHeader>
              <DialogTitle>Edit prompt</DialogTitle>
              <DialogDescription>
                The prompt text itself is fixed once it has run, so its recorded history always refers
                to the same question. Grouping, priority and the expected brand can change.
              </DialogDescription>
            </DialogHeader>

            <form onSubmit={submit} className="space-y-4">
              <div className="rounded-md border border-border bg-muted/40 p-3">
                <p className="text-xs leading-relaxed text-foreground">{prompt.prompt}</p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <FormField label="Category" description="Optional grouping." {...(error ? { error } : {})}>
                  <Input
                    name="category"
                    defaultValue={prompt.category ?? ''}
                    placeholder="comparison"
                    autoComplete="off"
                  />
                </FormField>

                <FormField label="Priority" description="0-100.">
                  <Input name="priority" type="number" min={0} max={100} defaultValue={prompt.priority} />
                </FormField>

                <FormField
                  label="Expected brand"
                  description={`Defaults to ${brandName} when left empty.`}
                  className="sm:col-span-2"
                >
                  <Input
                    name="expectedBrand"
                    defaultValue={prompt.expectedBrand ?? ''}
                    placeholder={brandName}
                    autoComplete="off"
                  />
                </FormField>
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
                  Cancel
                </Button>
                <Button type="submit" loading={pending} loadingText="Saving">
                  Save changes
                </Button>
              </DialogFooter>
            </form>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** Small header used above the table so the rates carry their definition with them. */
export function PromptRateLegend(): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-1 text-2xs text-muted-foreground">
      Rates are per prompt, across every recorded run
      <TooltipInfo
        label="How the per-prompt rates are calculated"
        content="Mention rate is the share of that prompt's runs in which the brand was named anywhere in the answer. Citation rate is the share in which at least one URL on your own domain was cited. Both are recomputed from every stored run, so they never drift."
      />
    </span>
  );
}
