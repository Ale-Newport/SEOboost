'use client';

import { useCallback, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Wallet } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { ProgressBar } from '@/components/ui/progress-bar';
import { StatList, StatListItem } from '@/components/ui/stat-list';
import { ApiError, apiPatch } from '@/lib/api-client';
import { formatNumber, formatUsd } from '@/lib/utils';

/**
 * The site's AI budget and what it has actually spent this month.
 *
 * Spend is summed from the `AiUsage` rows recorded for this website, so a site with no AI calls
 * reports exactly $0.00 rather than an estimate. The cap itself is advisory in the UI sense —
 * it is enforced where the calls are made — so the copy says what crossing it does.
 */

const MONTH = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' });

export interface AiBudgetCardProps {
  websiteId: string;
  monthlyBudgetUsd: number | null;
  monthToDateUsd: number;
  calls: number;
  periodStart: string;
  aiConfigured: boolean;
}

export function AiBudgetCard({
  websiteId,
  monthlyBudgetUsd,
  monthToDateUsd,
  calls,
  periodStart,
  aiConfigured,
}: AiBudgetCardProps): React.JSX.Element {
  const router = useRouter();
  const fieldId = useId();
  const [draft, setDraft] = useState(monthlyBudgetUsd === null ? '' : String(monthlyBudgetUsd));
  const [pending, setPending] = useState(false);

  const trimmed = draft.trim();
  const parsed = trimmed === '' ? null : Number(trimmed);
  const invalid = parsed !== null && (!Number.isFinite(parsed) || parsed < 0);
  const unchanged = (parsed ?? null) === (monthlyBudgetUsd ?? null);

  const save = useCallback(
    async (value: number | null) => {
      setPending(true);
      try {
        await apiPatch(`/api/websites/${websiteId}/settings`, { monthlyAiBudgetUsd: value });
        toast.success(value === null ? 'Budget cap removed' : `Budget set to ${formatUsd(value)}`);
        router.refresh();
      } catch (cause) {
        toast.error(cause instanceof ApiError ? cause.message : 'Could not save the budget.');
      } finally {
        setPending(false);
      }
    },
    [router, websiteId],
  );

  const percent =
    monthlyBudgetUsd !== null && monthlyBudgetUsd > 0
      ? Math.round((monthToDateUsd / monthlyBudgetUsd) * 100)
      : null;
  const over = percent !== null && percent >= 100;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wallet aria-hidden="true" className="size-4 text-primary" />
          AI budget
        </CardTitle>
        <CardDescription>
          What this site is allowed to spend on model calls each calendar month, and what it has
          spent so far.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <StatList divided>
          <StatListItem
            label={`Spent in ${MONTH.format(new Date(periodStart))}`}
            value={formatUsd(monthToDateUsd)}
            hint="Summed from the AI usage rows recorded for this website since the 1st. Nothing is estimated: no calls means $0.00."
          />
          <StatListItem
            label="Model calls"
            value={formatNumber(calls)}
            {...(calls === 0 ? { muted: true } : {})}
          />
          <StatListItem
            label="Monthly cap"
            value={monthlyBudgetUsd === null ? 'No cap' : formatUsd(monthlyBudgetUsd)}
            {...(monthlyBudgetUsd === null ? { muted: true } : {})}
          />
        </StatList>

        {monthlyBudgetUsd !== null && monthlyBudgetUsd > 0 ? (
          <ProgressBar
            label="Budget used"
            ariaLabel="Share of this month's AI budget already spent"
            value={Math.min(monthToDateUsd, monthlyBudgetUsd)}
            max={monthlyBudgetUsd}
            tone={over ? 'destructive' : percent !== null && percent >= 80 ? 'warning' : 'primary'}
            formatValue={() => `${formatUsd(monthToDateUsd)} of ${formatUsd(monthlyBudgetUsd)}`}
          />
        ) : null}

        {over ? (
          <p role="status" className="text-2xs leading-relaxed text-destructive">
            This site is over its cap for the month. Agents that need a model will be refused until
            the cap is raised or the month rolls over.
          </p>
        ) : null}

        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (invalid) return;
            void save(parsed);
          }}
        >
          <FormField
            label="Monthly cap (USD)"
            htmlFor={fieldId}
            className="flex-1"
            description="Leave empty for no cap."
            {...(invalid ? { error: 'Enter a positive amount, or leave it empty.' } : {})}
          >
            <Input
              id={fieldId}
              type="number"
              min={0}
              step="1"
              inputMode="decimal"
              value={draft}
              placeholder="No cap"
              onChange={(event) => setDraft(event.target.value)}
            />
          </FormField>
          <Button
            type="submit"
            variant="outline"
            className="mb-px"
            loading={pending}
            loadingText="Saving"
            disabled={invalid || unchanged}
          >
            Save
          </Button>
        </form>

        {!aiConfigured ? (
          <p className="text-2xs leading-relaxed text-muted-foreground">
            No AI provider key is set on this installation, so nothing can be spent yet. Set{' '}
            <code className="font-mono">ANTHROPIC_API_KEY</code>,{' '}
            <code className="font-mono">OPENAI_API_KEY</code> or{' '}
            <code className="font-mono">GOOGLE_AI_API_KEY</code> on the server.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
