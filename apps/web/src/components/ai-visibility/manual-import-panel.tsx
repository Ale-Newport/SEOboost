'use client';

import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ClipboardPaste, ShieldCheck } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { ApiError, apiPost } from '@/lib/api-client';
import { formatNumber } from '@/lib/utils';
import type { AiVisibilityPromptRow } from '@/server/queries/ai-visibility';

/**
 * The compliant path for assistants we cannot query through an API.
 *
 * The operator runs the prompt in the product's own interface and pastes the answer back. The
 * platform does not scrape consumer chat interfaces and does not drive them with a headless
 * browser — those are access-controlled products, and automating them would breach their terms.
 * A pasted answer is stored with `method: 'manual'` so it is never mistaken for an API sample.
 *
 * Nothing is invented on import: whether the brand appears, which cited URLs are yours and which
 * tracked competitors are named are all derived from the pasted text, and the response says what
 * was derived so you can check it.
 */

/** Assistants operators most often collect by hand. Any other name is accepted too. */
const COMMON_PROVIDERS = ['chatgpt', 'perplexity', 'gemini', 'copilot', 'claude', 'grok'] as const;

const AUTO = '__auto__';
const NONE = '__none__';

interface ImportResponse {
  derived: {
    brandName: string;
    brandMentioned: boolean;
    brandPosition: number | null;
    ourUrlsCited: string[];
    competitorsMentioned: string[];
  };
  promptRates: { runs: number; mentionRate: number | null; citationRate: number | null };
}

export function ManualImportPanel({
  websiteId,
  prompts,
}: {
  websiteId: string;
  prompts: readonly AiVisibilityPromptRow[];
}): React.JSX.Element {
  const router = useRouter();
  const selectable = useMemo(() => prompts.filter((prompt) => prompt.isActive), [prompts]);
  const fallback = selectable.length > 0 ? selectable : prompts;

  const [promptId, setPromptId] = useState<string>(fallback[0]?.id ?? '');
  const [provider, setProvider] = useState<string>('chatgpt');
  const [model, setModel] = useState('');
  const [answerText, setAnswerText] = useState('');
  const [citedUrls, setCitedUrls] = useState('');
  const [sentiment, setSentiment] = useState<string>(NONE);
  const [mentioned, setMentioned] = useState<string>(AUTO);
  const [runAt, setRunAt] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (pending) return;
      if (!promptId) {
        setError('Choose the prompt this answer came from.');
        return;
      }
      setPending(true);
      setError(null);
      try {
        const urls = citedUrls
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0);

        const result = await apiPost<ImportResponse>('/api/ai-visibility/import', {
          websiteId,
          promptId,
          provider: provider.trim().toLowerCase(),
          ...(model.trim() ? { model: model.trim() } : {}),
          answerText: answerText.trim(),
          citedUrls: urls,
          ...(mentioned === AUTO ? {} : { brandMentioned: mentioned === 'yes' }),
          ...(sentiment === NONE ? {} : { brandSentiment: sentiment }),
          ...(runAt ? { runAt: new Date(runAt).toISOString() } : {}),
        });

        toast.success(
          result.derived.brandMentioned
            ? `${result.derived.brandName} was named in this answer`
            : `${result.derived.brandName} was not named in this answer`,
          {
            description: `${formatNumber(result.derived.ourUrlsCited.length)} of your URLs cited · ${formatNumber(
              result.derived.competitorsMentioned.length,
            )} competitor(s) named · this prompt now has ${formatNumber(result.promptRates.runs)} recorded run(s).`,
            duration: 8_000,
          },
        );

        setAnswerText('');
        setCitedUrls('');
        setRunAt('');
        setMentioned(AUTO);
        setSentiment(NONE);
        router.refresh();
      } catch (cause) {
        setError(cause instanceof ApiError ? cause.message : 'Could not record this answer.');
      } finally {
        setPending(false);
      }
    },
    [answerText, citedUrls, mentioned, model, pending, promptId, provider, router, runAt, sentiment, websiteId],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ClipboardPaste aria-hidden="true" className="size-4 text-muted-foreground" />
          Import an answer collected by hand
        </CardTitle>
        <CardDescription>
          Some assistants have no API we can query. Rather than scrape a restricted interface — which
          their terms forbid and this platform will not do — run the prompt yourself and paste the
          answer here. It is stored as a manual observation, kept separate from API samples.
        </CardDescription>
      </CardHeader>

      <CardContent>
        {fallback.length === 0 ? (
          <EmptyState
            size="sm"
            bordered
            title="Add a prompt first"
            description="An imported answer has to attach to a tracked prompt so its rates can be counted. Add one in the prompt table above."
          />
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <FormField
                label="Prompt"
                required
                description="The tracked question this answer responded to."
                className="md:col-span-2"
              >
                <Select value={promptId} onValueChange={setPromptId}>
                  <SelectTrigger aria-label="Prompt this answer came from">
                    <SelectValue placeholder="Choose a prompt" />
                  </SelectTrigger>
                  <SelectContent>
                    {fallback.map((prompt) => (
                      <SelectItem key={prompt.id} value={prompt.id}>
                        {prompt.prompt.length > 90 ? `${prompt.prompt.slice(0, 90)}…` : prompt.prompt}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>

              <FormField label="Assistant" required description="Where the answer came from.">
                <Select value={provider} onValueChange={setProvider}>
                  <SelectTrigger aria-label="Assistant the answer came from">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {COMMON_PROVIDERS.map((name) => (
                      <SelectItem key={name} value={name}>
                        {name.charAt(0).toUpperCase() + name.slice(1)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>

              <FormField
                label="Model"
                description="Optional, but worth recording — answers differ sharply between models."
              >
                <Input
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  placeholder="gpt-5.1"
                  autoComplete="off"
                />
              </FormField>
            </div>

            <FormField
              label="The answer"
              required
              description="Paste the assistant's reply verbatim. Every derived figure is counted from this text."
              {...(error ? { error } : {})}
            >
              <Textarea
                value={answerText}
                onChange={(event) => setAnswerText(event.target.value)}
                rows={7}
                required
                placeholder="Paste the full answer here…"
              />
            </FormField>

            <FormField
              label="Cited URLs"
              description="One per line, in the order the answer cited them. URLs on your own domain are matched by hostname, so a competitor's article about you is never counted as your citation."
            >
              <Textarea
                value={citedUrls}
                onChange={(event) => setCitedUrls(event.target.value)}
                rows={3}
                placeholder={'https://example.com/guide\nhttps://competitor.com/comparison'}
              />
            </FormField>

            <div className="grid gap-4 md:grid-cols-3">
              <FormField
                label="Brand mentioned"
                description="Leave on automatic unless the text match gets it wrong."
              >
                <Select value={mentioned} onValueChange={setMentioned}>
                  <SelectTrigger aria-label="Whether the brand was mentioned">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={AUTO}>Detect from the text</SelectItem>
                    <SelectItem value="yes">Yes, it was named</SelectItem>
                    <SelectItem value="no">No, it was not</SelectItem>
                  </SelectContent>
                </Select>
              </FormField>

              <FormField label="Sentiment" description="Only if you can judge it from the answer.">
                <Select value={sentiment} onValueChange={setSentiment}>
                  <SelectTrigger aria-label="Sentiment towards the brand">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Leave unclassified</SelectItem>
                    <SelectItem value="positive">Positive</SelectItem>
                    <SelectItem value="neutral">Neutral</SelectItem>
                    <SelectItem value="negative">Negative</SelectItem>
                  </SelectContent>
                </Select>
              </FormField>

              <FormField label="Collected at" description="Defaults to now.">
                <Input
                  type="datetime-local"
                  value={runAt}
                  onChange={(event) => setRunAt(event.target.value)}
                />
              </FormField>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
              <p className="flex items-start gap-2 text-2xs leading-relaxed text-muted-foreground">
                <ShieldCheck aria-hidden="true" className="mt-px size-3.5 shrink-0" />
                <span>
                  Recorded as a manual observation. Nothing here is scraped, and no field is filled in
                  on your behalf beyond what the pasted text supports.
                </span>
              </p>
              <Button type="submit" size="sm" loading={pending} loadingText="Recording">
                Record answer
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
