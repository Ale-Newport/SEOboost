'use client';

import { useCallback, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { BadgeCheck, Plus, ShieldAlert, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, apiDelete, apiPost } from '@/lib/api-client';
import { updateBrandFact } from '@/components/site-settings/actions';
import type { BrandFactRow } from '@/components/site-settings/types';

/**
 * First-party facts an AI writer is allowed to assert.
 *
 * The `verified` switch is the whole point of this screen: the content pipeline may only put a
 * verified fact into published copy, and anything unverified is held for review instead. So the
 * switch is a claim a human is making — which is why flipping it stamps who and when.
 */

const DATE = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' });

interface NewFact {
  fact: string;
  category: string;
  source: string;
  sourceUrl: string;
  verified: boolean;
}

const EMPTY_FACT: NewFact = {
  fact: '',
  category: '',
  source: 'internal',
  sourceUrl: '',
  verified: false,
};

export interface BrandFactsTabProps {
  websiteId: string;
  facts: readonly BrandFactRow[];
  counts: { total: number; verified: number; unverified: number; expired: number };
}

export function BrandFactsTab({ websiteId, facts, counts }: BrandFactsTabProps): React.JSX.Element {
  const router = useRouter();
  const ids = useId();
  const [draft, setDraft] = useState<NewFact>(EMPTY_FACT);
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<BrandFactRow | null>(null);

  const add = useCallback(async () => {
    setAdding(true);
    try {
      await apiPost(`/api/websites/${websiteId}/brand-facts`, {
        fact: draft.fact.trim(),
        ...(draft.category.trim() ? { category: draft.category.trim() } : {}),
        source: draft.source.trim() || 'internal',
        ...(draft.sourceUrl.trim() ? { sourceUrl: draft.sourceUrl.trim() } : {}),
        verified: draft.verified,
      });
      toast.success('Fact added', {
        description: draft.verified
          ? 'Writers may assert it from now on.'
          : 'It stays out of published copy until you verify it.',
      });
      setDraft(EMPTY_FACT);
      router.refresh();
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : 'Could not add that fact.');
    } finally {
      setAdding(false);
    }
  }, [draft, router, websiteId]);

  const toggleVerified = useCallback(
    async (fact: BrandFactRow, verified: boolean) => {
      setBusyId(fact.id);
      try {
        const result = await updateBrandFact({ websiteId, factId: fact.id, verified });
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
        toast.success(
          verified ? 'Fact verified' : 'Verification removed',
          {
            description: verified
              ? 'Writers may now assert it in published copy.'
              : 'Drafts that rely on it will be held for review.',
          },
        );
        router.refresh();
      } finally {
        setBusyId(null);
      }
    },
    [router, websiteId],
  );

  const remove = useCallback(async () => {
    if (!pendingDelete) return;
    try {
      await apiDelete(`/api/websites/${websiteId}/brand-facts?id=${encodeURIComponent(pendingDelete.id)}`);
      toast.success('Fact deleted');
      setPendingDelete(null);
      router.refresh();
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : 'Could not delete that fact.');
      throw cause;
    }
  }, [pendingDelete, router, websiteId]);

  const now = Date.now();

  return (
    <div className="space-y-6">
      <Alert variant="neutral" icon={ShieldAlert}>
        <AlertTitle>Only verified facts reach published copy</AlertTitle>
        <AlertDescription>
          An AI writer may assert a fact from this list only while it is marked verified. Anything
          unverified — or past its expiry — is treated as an unsupported claim, and a draft that
          depends on it is held for your review instead of being published. Facts about prices,
          headcount, awards and certifications go stale; give those an expiry.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle>Add a fact</CardTitle>
          <CardDescription>
            One checkable claim per entry, written the way you would want it quoted.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (draft.fact.trim().length < 3) return;
              void add();
            }}
          >
            <FormField
              label="Fact"
              htmlFor={`${ids}-fact`}
              description="Specific and checkable — “Founded in 2014 in Rotterdam”, not “a leading provider”."
              required
            >
              <Textarea
                id={`${ids}-fact`}
                rows={2}
                value={draft.fact}
                onChange={(event) => setDraft({ ...draft, fact: event.target.value })}
              />
            </FormField>

            <div className="grid gap-4 md:grid-cols-3">
              <FormField
                label="Category"
                htmlFor={`${ids}-category`}
                description="Optional grouping: pricing, company, product."
              >
                <Input
                  id={`${ids}-category`}
                  value={draft.category}
                  onChange={(event) => setDraft({ ...draft, category: event.target.value })}
                  autoComplete="off"
                />
              </FormField>

              <FormField
                label="Source"
                htmlFor={`${ids}-source`}
                description="Where it comes from — internal, press release, audited report."
              >
                <Input
                  id={`${ids}-source`}
                  value={draft.source}
                  onChange={(event) => setDraft({ ...draft, source: event.target.value })}
                  autoComplete="off"
                />
              </FormField>

              <FormField
                label="Source URL"
                htmlFor={`${ids}-source-url`}
                description="Optional link a reviewer can check it against."
              >
                <Input
                  id={`${ids}-source-url`}
                  type="url"
                  value={draft.sourceUrl}
                  onChange={(event) => setDraft({ ...draft, sourceUrl: event.target.value })}
                  className="font-mono text-xs"
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="https://…"
                />
              </FormField>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 text-sm text-foreground">
                <Switch
                  id={`${ids}-verified`}
                  checked={draft.verified}
                  onCheckedChange={(value) => setDraft({ ...draft, verified: value })}
                />
                <label htmlFor={`${ids}-verified`}>
                  Verified
                  <span className="ml-1.5 text-xs text-muted-foreground">
                    — I have checked this and writers may assert it.
                  </span>
                </label>
              </div>

              <Button
                type="submit"
                size="sm"
                loading={adding}
                loadingText="Adding"
                disabled={draft.fact.trim().length < 3}
              >
                <Plus aria-hidden="true" />
                Add fact
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            Brand facts
            <Badge variant="success" className="font-normal">
              <BadgeCheck aria-hidden="true" className="size-3" />
              {counts.verified} verified
            </Badge>
            {counts.unverified > 0 ? (
              <Badge variant="warning" className="font-normal">
                {counts.unverified} unverified
              </Badge>
            ) : null}
            {counts.expired > 0 ? (
              <Badge variant="destructive" className="font-normal">
                {counts.expired} expired
              </Badge>
            ) : null}
          </CardTitle>
          <CardDescription>
            {counts.total > facts.length
              ? `Showing the ${facts.length} most recent of ${counts.total}.`
              : 'Verified facts first, then newest.'}
          </CardDescription>
        </CardHeader>

        <CardContent>
          {facts.length === 0 ? (
            <EmptyState
              size="sm"
              bordered
              icon={ShieldAlert}
              title="No brand facts recorded"
              description="Add the claims you want writers to be able to make — founding date, customer count, certifications, pricing. Until this list has verified entries, drafts will avoid asserting anything specific about the business."
            />
          ) : (
            <ul className="divide-y divide-border">
              {facts.map((fact) => {
                const expired = fact.expiresAt !== null && new Date(fact.expiresAt).getTime() <= now;
                const busy = busyId === fact.id;

                return (
                  <li key={fact.id} className="flex flex-wrap items-start gap-x-4 gap-y-2 py-3 first:pt-0">
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="text-sm leading-relaxed text-foreground">{fact.fact}</p>

                      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted-foreground">
                        {fact.category ? (
                          <Badge variant="muted" className="font-normal">
                            {fact.category}
                          </Badge>
                        ) : null}
                        <span>Source: {fact.source}</span>
                        {fact.sourceUrl ? (
                          <>
                            <span aria-hidden="true">·</span>
                            <a
                              href={fact.sourceUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="break-all font-mono text-primary underline-offset-4 hover:underline"
                            >
                              {fact.sourceUrl}
                            </a>
                          </>
                        ) : null}
                        <span aria-hidden="true">·</span>
                        <span>Added {DATE.format(new Date(fact.createdAt))}</span>
                        {fact.verifiedAt ? (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>Verified {DATE.format(new Date(fact.verifiedAt))}</span>
                          </>
                        ) : null}
                        {fact.expiresAt ? (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className={expired ? 'text-destructive' : undefined}>
                              {expired ? 'Expired' : 'Expires'} {DATE.format(new Date(fact.expiresAt))}
                            </span>
                          </>
                        ) : null}
                      </p>

                      {expired ? (
                        <p className="text-2xs text-destructive">
                          Past its expiry, so writers treat it as unsupported even though it is
                          marked verified. Re-check it and update the expiry.
                        </p>
                      ) : null}
                    </div>

                    <div className="flex shrink-0 items-center gap-3">
                      <span className="flex items-center gap-2 text-2xs text-muted-foreground">
                        <Switch
                          checked={fact.verified}
                          disabled={busy}
                          aria-label={`Mark verified: ${fact.fact.slice(0, 60)}`}
                          onCheckedChange={(value) => void toggleVerified(fact, value)}
                        />
                        <span aria-hidden="true">{fact.verified ? 'Verified' : 'Unverified'}</span>
                      </span>

                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8"
                        aria-label={`Delete fact: ${fact.fact.slice(0, 60)}`}
                        onClick={() => setPendingDelete(fact)}
                      >
                        <Trash2 aria-hidden="true" />
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        destructive
        title="Delete this fact?"
        description={
          <>
            <span className="block">{pendingDelete?.fact}</span>
            <span className="mt-2 block">
              Writers lose the ability to assert it. Content already published is untouched.
            </span>
          </>
        }
        confirmLabel="Delete fact"
        onConfirm={remove}
      />
    </div>
  );
}
