'use client';

import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

import { ApiError, apiPatch, apiPost } from '@/lib/api-client';
import { toast } from '@/components/ui/toast';

/** Result of the fix-action call, so the caller can link straight to what it created. */
export interface CreatedFixAction {
  id: string;
  title: string;
  status: string;
  priorityScore: number;
}

export interface IssueMutations {
  /** True while any triage request is in flight; disable the controls that fired it. */
  pending: boolean;
  ignore: (issueIds: readonly string[], reason: string) => Promise<boolean>;
  reopen: (issueIds: readonly string[]) => Promise<boolean>;
  createFixAction: (issueId: string) => Promise<CreatedFixAction | null>;
}

function message(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

/**
 * Issue triage against the API, shared by the table's row menu, its bulk bar and the detail
 * drawer so all three report success and failure the same way.
 *
 * Every call ends in `router.refresh()`: the health score, the category summary and the facet
 * counts are all derived from the same rows on the server, and letting the client patch one of
 * them locally would leave the other two quietly wrong.
 */
export function useIssueMutations(websiteId: string): IssueMutations {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  const patch = useCallback(
    async (
      issueIds: readonly string[],
      body: { action: 'ignore' | 'reopen'; reason?: string },
      labels: { one: string; many: (n: number) => string; failed: string },
    ): Promise<boolean> => {
      if (issueIds.length === 0) return false;
      setPending(true);
      try {
        const results = await Promise.allSettled(
          issueIds.map((id) => apiPatch(`/api/websites/${websiteId}/issues/${id}`, body)),
        );
        const failures = results.filter((result) => result.status === 'rejected');
        const succeeded = results.length - failures.length;

        if (succeeded > 0) {
          toast.success(succeeded === 1 ? labels.one : labels.many(succeeded));
        }
        if (failures.length > 0) {
          const first = failures[0];
          toast.error(labels.failed, {
            description:
              first && first.status === 'rejected'
                ? message(first.reason, `${failures.length} issue(s) could not be updated.`)
                : `${failures.length} issue(s) could not be updated.`,
          });
        }

        router.refresh();
        return failures.length === 0;
      } finally {
        setPending(false);
      }
    },
    [router, websiteId],
  );

  const ignore = useCallback(
    (issueIds: readonly string[], reason: string) =>
      patch(issueIds, { action: 'ignore', reason }, {
        one: 'Issue ignored',
        many: (n) => `${n} issues ignored`,
        failed: 'Some issues could not be ignored',
      }),
    [patch],
  );

  const reopen = useCallback(
    (issueIds: readonly string[]) =>
      patch(issueIds, { action: 'reopen' }, {
        one: 'Issue reopened',
        many: (n) => `${n} issues reopened`,
        failed: 'Some issues could not be reopened',
      }),
    [patch],
  );

  const createFixAction = useCallback(
    async (issueId: string): Promise<CreatedFixAction | null> => {
      setPending(true);
      try {
        const result = await apiPost<{ action: CreatedFixAction; nextStep: string }>(
          `/api/websites/${websiteId}/issues/${issueId}/fix`,
          {},
        );
        toast.success('Fix action proposed', { description: result.nextStep });
        router.refresh();
        return result.action;
      } catch (error) {
        toast.error(message(error, 'Could not create a fix action for this issue'));
        return null;
      } finally {
        setPending(false);
      }
    },
    [router, websiteId],
  );

  // Memoised so the table's column definitions — which close over these — stay stable between
  // renders that changed nothing but the row data.
  return useMemo(
    () => ({ pending, ignore, reopen, createFixAction }),
    [pending, ignore, reopen, createFixAction],
  );
}
