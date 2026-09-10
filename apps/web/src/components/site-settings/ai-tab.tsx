'use client';

import { useCallback, useId, useState } from 'react';
import { KeyRound } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { apiPatch } from '@/lib/api-client';
import { SettingsSection, isSame, useSaveHandler } from '@/components/site-settings/settings-form';
import {
  MODEL_ROLE_COLUMN,
  MODEL_ROLE_COPY,
  MODEL_ROLE_ORDER,
  type AiDefaults,
  type AiSettings,
  type ModelRole,
  type ProviderOption,
} from '@/components/site-settings/types';

/**
 * Which model answers for this site, per role.
 *
 * Routing resolves in one direction: this site's choice, then the operator's installation-wide
 * default, then the provider's built-in. Every control therefore shows what it would inherit if
 * left alone, so "Use the default" is an informed choice rather than a blank.
 *
 * No API key is shown or entered here — keys are environment variables on the server, and the
 * screen only reports whether one is present.
 */

const INHERIT = '__inherit__';

export interface AiTabProps {
  websiteId: string;
  ai: AiSettings;
  providers: readonly ProviderOption[];
  defaults: AiDefaults;
}

export function AiTab({ websiteId, ai, providers, defaults }: AiTabProps): React.JSX.Element {
  const ids = useId();
  const { pending, run } = useSaveHandler();
  const [draft, setDraft] = useState<AiSettings>(ai);

  const dirty = !isSame(draft, ai);

  const set = useCallback(<K extends keyof AiSettings>(key: K, value: AiSettings[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  }, []);

  const save = useCallback(() => {
    void run(
      () =>
        apiPatch(`/api/websites/${websiteId}/settings`, {
          aiProvider: draft.aiProvider,
          reasoningModel: draft.reasoningModel,
          fastModel: draft.fastModel,
          writingModel: draft.writingModel,
          embeddingModel: draft.embeddingModel,
          monthlyAiBudgetUsd: draft.monthlyAiBudgetUsd,
        }),
      'AI settings saved',
    );
  }, [draft, run, websiteId]);

  // The provider a call would use with the current draft, so the model lists below match what
  // would actually be asked.
  const selectedProvider =
    providers.find((provider) => provider.name === (draft.aiProvider ?? defaults.provider)) ??
    providers.find((provider) => provider.name === defaults.effectiveProvider) ??
    null;

  const chosenUnconfigured =
    draft.aiProvider !== null &&
    providers.find((provider) => provider.name === draft.aiProvider)?.configured === false;

  const budgetInvalid =
    draft.monthlyAiBudgetUsd !== null &&
    (!Number.isFinite(draft.monthlyAiBudgetUsd) || draft.monthlyAiBudgetUsd < 0);

  function modelsForRole(role: ModelRole) {
    if (!selectedProvider) return [];
    return selectedProvider.models.filter((model) => model.roles.includes(role));
  }

  function inheritedModel(role: ModelRole): string {
    const operator = defaults.models[role];
    if (operator) return `${operator} (installation default)`;
    const builtIn = selectedProvider?.builtIn[role] ?? null;
    if (builtIn) return `${builtIn} (${selectedProvider?.label ?? 'provider'} built-in)`;
    return 'nothing — this role has no model on the selected provider';
  }

  return (
    <div className="space-y-6">
      {!defaults.anyConfigured ? (
        <Alert variant="warning" icon={KeyRound}>
          <AlertTitle>No AI provider is configured on this installation</AlertTitle>
          <AlertDescription>
            Every agent that needs a language model is blocked until one of{' '}
            {providers.map((provider, index) => (
              <span key={provider.name}>
                {index > 0 ? ', ' : ''}
                <code className="font-mono text-2xs">{provider.envVar}</code>
              </span>
            ))}{' '}
            is set on the server. Choices made here are stored and take effect as soon as a key is.
          </AlertDescription>
        </Alert>
      ) : null}

      <SettingsSection
        title="Provider and models"
        description="Per-site overrides for model routing. Anything left on “use the default” follows the installation-wide setting, which follows the provider's built-in."
        dirty={dirty}
        pending={pending}
        onSave={save}
        onReset={() => setDraft(ai)}
        blockedReason={budgetInvalid ? 'The budget must be a positive amount, or empty for no cap.' : null}
        footerNote={
          defaults.effectiveProvider
            ? `Calls for this site currently go to ${
                providers.find((provider) => provider.name === defaults.effectiveProvider)?.label ??
                defaults.effectiveProvider
              }.`
            : 'No provider can serve a call right now.'
        }
      >
        <FormField
          label="Provider"
          htmlFor={`${ids}-provider`}
          description={
            defaults.provider
              ? `Left on the default, this site uses ${defaults.provider}, the installation-wide choice.`
              : 'Left on the default, this site uses the first provider whose key is present.'
          }
        >
          <Select
            value={draft.aiProvider ?? INHERIT}
            onValueChange={(value) => set('aiProvider', value === INHERIT ? null : value)}
          >
            <SelectTrigger id={`${ids}-provider`} className="md:w-80">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={INHERIT}>Use the installation default</SelectItem>
              {providers.map((provider) => (
                <SelectItem key={provider.name} value={provider.name}>
                  {provider.label}
                  {provider.configured ? '' : ' — no key set'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>

        {chosenUnconfigured ? (
          <Alert variant="warning">
            <AlertTitle>That provider has no API key on this server</AlertTitle>
            <AlertDescription>
              The choice is saved, but calls will be refused until{' '}
              <code className="font-mono text-2xs">
                {providers.find((provider) => provider.name === draft.aiProvider)?.envVar}
              </code>{' '}
              is set.
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="space-y-4">
          {MODEL_ROLE_ORDER.map((role) => {
            const column = MODEL_ROLE_COLUMN[role];
            const current = draft[column];
            const options = modelsForRole(role);
            const unsupported =
              role === 'embedding' && selectedProvider !== null && !selectedProvider.supportsEmbeddings;

            return (
              <FormField
                key={role}
                label={
                  <span className="flex items-center gap-2">
                    {MODEL_ROLE_COPY[role].label}
                    {current ? (
                      <Badge variant="secondary" className="font-normal">
                        Overridden
                      </Badge>
                    ) : null}
                  </span>
                }
                htmlFor={`${ids}-${role}`}
                description={
                  <>
                    {MODEL_ROLE_COPY[role].description}{' '}
                    {unsupported ? (
                      <span className="text-warning">
                        {selectedProvider?.label} has no embeddings endpoint — vectors are served by
                        another configured provider regardless of what is chosen here.
                      </span>
                    ) : (
                      <>Left alone, this role uses {inheritedModel(role)}.</>
                    )}
                  </>
                }
              >
                <Select
                  value={current ?? INHERIT}
                  onValueChange={(value) =>
                    setDraft((state) => ({ ...state, [column]: value === INHERIT ? null : value }))
                  }
                >
                  <SelectTrigger id={`${ids}-${role}`} className="md:w-80">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={INHERIT}>Use the default</SelectItem>
                    {options.map((model) => (
                      <SelectItem key={model.id} value={model.id}>
                        {model.label}
                      </SelectItem>
                    ))}
                    {/* A model stored before the catalogue changed must stay selectable, or
                        opening this screen would silently reset it. */}
                    {current && !options.some((model) => model.id === current) ? (
                      <SelectItem value={current}>{current} (not in the catalogue)</SelectItem>
                    ) : null}
                  </SelectContent>
                </Select>
              </FormField>
            );
          })}
        </div>

        <FormField
          label="Monthly AI budget"
          htmlFor={`${ids}-budget`}
          description="Cap on what this site may spend on model calls per calendar month. Leave empty for no cap. Month-to-date spend is on the Automations screen."
          {...(budgetInvalid ? { error: 'Enter a positive amount, or leave it empty.' } : {})}
        >
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">USD</span>
            <Input
              id={`${ids}-budget`}
              type="number"
              min={0}
              step="1"
              inputMode="decimal"
              placeholder="No cap"
              value={draft.monthlyAiBudgetUsd ?? ''}
              onChange={(event) =>
                set('monthlyAiBudgetUsd', event.target.value === '' ? null : Number(event.target.value))
              }
              className="md:w-40"
            />
          </div>
        </FormField>
      </SettingsSection>

      <Alert variant="neutral" icon={KeyRound}>
        <AlertTitle>API keys are never stored here</AlertTitle>
        <AlertDescription>
          Provider keys are environment variables on the server (
          {providers.map((provider, index) => (
            <span key={provider.name}>
              {index > 0 ? ', ' : ''}
              <code className="font-mono text-2xs">{provider.envVar}</code>
              {provider.configured ? ' — set' : ' — not set'}
            </span>
          ))}
          ). This screen only reports whether each one is present.
        </AlertDescription>
      </Alert>
    </div>
  );
}
