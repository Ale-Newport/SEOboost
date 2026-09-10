'use client';

import * as React from 'react';
import { ArrowRight, Plus, Users, X } from 'lucide-react';
import { domainSchema } from '@seo/shared/validation';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { saveCompetitors } from './actions';
import { StepFooter, StepHeader } from './step-shell';
import type { OnboardingWebsite } from './types';

/** How many rows this step offers on a fresh site. Existing entries are never truncated to it. */
const MAX_COMPETITORS = 5;

interface StepCompetitorsProps {
  site: OnboardingWebsite;
  onSaved: (site: OnboardingWebsite) => void;
  onNext: () => void;
  onBack: () => void;
}

/**
 * Always render at least one empty row so the step never looks like a dead end — and render
 * *every* competitor the site already has. Saving replaces the whole manual set, so a row the
 * form never showed would be deleted by a step the user thought they were only skipping past.
 */
function initialRows(competitors: string[]): string[] {
  return competitors.length > 0 ? [...competitors] : [''];
}

export function StepCompetitors({ site, onSaved, onNext, onBack }: StepCompetitorsProps) {
  const [rows, setRows] = React.useState<string[]>(() => initialRows(site.competitors));
  // Never fewer slots than the site already uses.
  const maxRows = Math.max(MAX_COMPETITORS, site.competitors.length);
  const [rowErrors, setRowErrors] = React.useState<Record<number, string>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  const setRow = (index: number, value: string) => {
    setRows((current) => current.map((row, position) => (position === index ? value : row)));
    setRowErrors((current) => {
      if (!(index in current)) return current;
      const next = { ...current };
      delete next[index];
      return next;
    });
  };

  const addRow = () => setRows((current) => (current.length >= maxRows ? current : [...current, '']));

  const removeRow = (index: number) => {
    setRows((current) => {
      const next = current.filter((_, position) => position !== index);
      return next.length > 0 ? next : [''];
    });
    setRowErrors({});
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    setNotice(null);

    // Blank rows are "I left this empty", not an error.
    const filled = rows.map((row, index) => ({ row: row.trim(), index })).filter((entry) => entry.row !== '');

    const errors: Record<number, string> = {};
    const domains: string[] = [];
    const seen = new Set<string>();
    for (const entry of filled) {
      const parsed = domainSchema.safeParse(entry.row);
      if (!parsed.success) {
        errors[entry.index] = parsed.error.issues[0]?.message ?? 'Enter a valid domain.';
        continue;
      }
      /*
       * The server drops the site's own domain and reports it as `skipped`, but this step
       * advances on success — a message set here would unmount before it could be read. Both
       * cases are caught on the row instead, where the answer is to edit that row.
       */
      if (parsed.data === site.domain) {
        errors[entry.index] = `${site.domain} is this site's own domain.`;
        continue;
      }
      if (seen.has(parsed.data)) {
        errors[entry.index] = `${parsed.data} is already listed above.`;
        continue;
      }
      seen.add(parsed.data);
      domains.push(parsed.data);
    }

    if (Object.keys(errors).length > 0) {
      setRowErrors(errors);
      return;
    }
    setRowErrors({});
    setSaving(true);

    const result = await saveCompetitors({ websiteId: site.id, domains });
    setSaving(false);

    if (!result.ok) {
      setFormError(result.error);
      return;
    }

    // Own-domain rows are rejected above, so `skipped` should always be empty here. If the
    // server ever disagrees, stay on the step and say so rather than advancing on a half-save.
    if (result.data.skipped.length > 0) {
      const rejected = new Set(result.data.skipped);
      setRows((current) => {
        const kept = current.filter((row) => {
          // `skipped` holds normalised domains, so compare like with like.
          const parsed = domainSchema.safeParse(row);
          return !parsed.success || !rejected.has(parsed.data);
        });
        return kept.length > 0 ? kept : [''];
      });
      setNotice(
        `${result.data.skipped.join(', ')} was not added: a competitor cannot be this site's own domain.`,
      );
      return;
    }

    onSaved({ ...site, competitors: domains });
    onNext();
  };

  return (
    <form onSubmit={submit} noValidate>
      <StepHeader
        icon={Users}
        title="Who are you competing with?"
        description={`Up to ${MAX_COMPETITORS} domains that rank for the things you want to rank for. Used for keyword-gap and SERP-overlap analysis.`}
      />

      <div className="mt-6 space-y-3">
        {formError ? (
          <Alert variant="destructive">
            <AlertDescription className="text-foreground">{formError}</AlertDescription>
          </Alert>
        ) : null}

        {notice ? (
          <Alert variant="warning">
            <AlertDescription className="text-foreground">{notice}</AlertDescription>
          </Alert>
        ) : null}

        {rows.map((row, index) => (
          <div key={index} className="flex items-start gap-2">
            <FormField
              label={`Competitor ${index + 1}`}
              hideLabel
              error={rowErrors[index]}
              className="min-w-0 flex-1"
            >
              <Input
                value={row}
                onChange={(event) => setRow(index, event.target.value)}
                placeholder="competitor.com"
                spellCheck={false}
                autoCapitalize="none"
                inputMode="url"
                aria-label={`Competitor ${index + 1} domain`}
                disabled={saving}
              />
            </FormField>
            <button
              type="button"
              onClick={() => removeRow(index)}
              aria-label={`Remove competitor ${index + 1}`}
              disabled={saving}
              className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
        ))}

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={addRow}
          disabled={rows.length >= maxRows || saving}
        >
          <Plus aria-hidden="true" />
          Add competitor
        </Button>

        <p className="text-xs leading-relaxed text-muted-foreground">
          Competitor pages are only ever read the way any visitor reads them — public URLs, robots
          rules respected. Nothing behind a login is touched.
        </p>
      </div>

      <StepFooter onBack={onBack} onSkip={onNext}>
        <Button type="submit" loading={saving} loadingText="Saving competitors">
          Save and continue
          <ArrowRight aria-hidden="true" />
        </Button>
      </StepFooter>
    </form>
  );
}
