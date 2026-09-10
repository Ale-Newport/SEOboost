'use client';

import * as React from 'react';
import { ArrowRight, Bot, CircleCheck, CircleSlash } from 'lucide-react';
import { z } from 'zod';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { RadioGroup, RadioGroupOption } from '@/components/ui/radio-group';
import { apiGet } from '@/lib/api-client';
import { saveDefaultAiProvider } from './actions';
import { StepFooter, StepHeader } from './step-shell';
import type { AiProviderOption } from './types';

const PROVIDERS_ENDPOINT = '/api/settings/ai/providers';

const providerSchema = z.object({
  name: z.string(),
  configured: z.boolean(),
  label: z.string().nullish(),
  envVar: z.string().nullish(),
});

const responseSchema = z.union([
  z.array(providerSchema),
  z.object({ providers: z.array(providerSchema) }),
]);

interface StepAiProviderProps {
  /** Rendered immediately from the server's own view of the registry. */
  initialProviders: AiProviderOption[];
  initialSelection: string | null;
  onNext: () => void;
  onBack: () => void;
}

/**
 * AI provider selection.
 *
 * The list is rendered from the server's registry view straight away and then refreshed from
 * `/api/settings/ai/providers`, which is the authority the settings screen uses too. A failed
 * refresh keeps the server's answer rather than blanking the step — both are real readings of
 * the same registry.
 */
export function StepAiProvider({
  initialProviders,
  initialSelection,
  onNext,
  onBack,
}: StepAiProviderProps) {
  const [providers, setProviders] = React.useState(initialProviders);
  const [selected, setSelected] = React.useState<string | null>(() => {
    if (initialSelection && initialProviders.some((p) => p.name === initialSelection && p.configured)) {
      return initialSelection;
    }
    return initialProviders.find((p) => p.configured)?.name ?? null;
  });
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    let disposed = false;

    apiGet<unknown>(PROVIDERS_ENDPOINT)
      .then((payload) => {
        if (disposed) return;
        const parsed = responseSchema.safeParse(payload);
        if (!parsed.success) return;
        const rows = Array.isArray(parsed.data) ? parsed.data : parsed.data.providers;
        if (rows.length === 0) return;

        setProviders((current) =>
          rows.map((row) => {
            const known = current.find((entry) => entry.name === row.name);
            return {
              name: row.name,
              label: row.label ?? known?.label ?? row.name,
              configured: row.configured,
              envVar: row.envVar ?? known?.envVar ?? '',
            };
          }),
        );
      })
      .catch(() => {
        // The server-rendered list is already correct; a failed refresh changes nothing.
      });

    return () => {
      disposed = true;
    };
  }, []);

  const configured = providers.filter((provider) => provider.configured);
  const missing = providers.filter((provider) => !provider.configured);

  // The refresh can reveal that the pre-selected provider has no key after all.
  React.useEffect(() => {
    setSelected((current) => {
      const usable = providers.filter((provider) => provider.configured);
      if (current && usable.some((provider) => provider.name === current)) return current;
      return usable[0]?.name ?? null;
    });
  }, [providers]);

  const save = async () => {
    if (!selected) {
      onNext();
      return;
    }
    setError(null);
    setSaving(true);
    const result = await saveDefaultAiProvider({ provider: selected });
    setSaving(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onNext();
  };

  return (
    <div>
      <StepHeader
        icon={Bot}
        title="Choose the default AI provider"
        description="Agents, content drafting, briefs and embeddings all need at least one provider key. Everything deterministic — crawling, the technical audit, scoring, the link graph — works without one."
      />

      <div className="mt-6 space-y-4">
        {error ? (
          <Alert variant="destructive">
            <AlertDescription className="text-foreground">{error}</AlertDescription>
          </Alert>
        ) : null}

        {configured.length === 0 ? (
          <Alert variant="warning">
            <AlertTitle>No AI provider is configured</AlertTitle>
            <AlertDescription>
              Set one of the keys below in the environment and restart the app. Until then the
              agents, content pipeline and AI-visibility screens will say they are unavailable
              rather than produce output.
            </AlertDescription>
          </Alert>
        ) : (
          <RadioGroup
            value={selected ?? undefined}
            onValueChange={setSelected}
            aria-label="Default AI provider"
            className="space-y-2"
          >
            {configured.map((provider) => (
              <RadioGroupOption
                key={provider.name}
                value={provider.name}
                label={
                  <span className="flex items-center gap-2">
                    {provider.label}
                    <CircleCheck className="size-3.5 text-success" aria-hidden="true" />
                  </span>
                }
                description={`Key found in ${provider.envVar || 'the environment'}. Individual sites can override this later.`}
              />
            ))}
          </RadioGroup>
        )}

        {missing.length > 0 ? (
          <div className="rounded-md border border-border bg-muted/30 p-4">
            <p className="text-sm font-medium">Not configured</p>
            <ul className="mt-2 space-y-1.5">
              {missing.map((provider) => (
                <li key={provider.name} className="flex items-center gap-2 text-xs text-muted-foreground">
                  <CircleSlash className="size-3.5 shrink-0" aria-hidden="true" />
                  <span className="font-medium text-foreground">{provider.label}</span>
                  {provider.envVar ? (
                    <code className="rounded border border-border bg-muted px-1 py-0.5 font-mono text-2xs text-foreground">
                      {provider.envVar}
                    </code>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      {/* With nothing to choose from there is nothing to skip past — one button, honestly labelled. */}
      <StepFooter onBack={onBack} onSkip={selected ? onNext : undefined}>
        <Button onClick={() => void save()} loading={saving} loadingText="Saving provider">
          {selected ? 'Save and continue' : 'Continue without AI'}
          <ArrowRight aria-hidden="true" />
        </Button>
      </StepFooter>
    </div>
  );
}
