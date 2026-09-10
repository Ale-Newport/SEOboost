'use client';

import { useCallback, useId, useState } from 'react';
import { BookOpen, Plus, Trash2 } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Textarea } from '@/components/ui/textarea';
import { saveKnowledgeBase } from '@/components/site-settings/actions';
import { ListField, SettingsSection, isSame, useSaveHandler } from '@/components/site-settings/settings-form';
import type {
  KnowledgeAuthor,
  KnowledgeBaseData,
  KnowledgeProduct,
  KnowledgeTerm,
} from '@/components/site-settings/types';

/**
 * The material the content agents are allowed to write from.
 *
 * This is the difference between a draft that sounds like the business and a draft that sounds
 * like a language model guessing. Author bios in particular are load-bearing: the pipeline will
 * not invent a byline, so an empty list means drafts carry no author rather than a plausible
 * fabrication.
 */

interface Draft {
  businessDescription: string;
  audience: string;
  toneOfVoice: string;
  brandStyle: string;
  preferredCta: string;
  writingGuidelines: string;
  prohibitedClaims: string[];
  uniqueValueProps: string[];
  products: KnowledgeProduct[];
  terminology: KnowledgeTerm[];
  authorBios: KnowledgeAuthor[];
}

function toDraft(knowledge: KnowledgeBaseData): Draft {
  return {
    businessDescription: knowledge.businessDescription ?? '',
    audience: knowledge.audience ?? '',
    toneOfVoice: knowledge.toneOfVoice ?? '',
    brandStyle: knowledge.brandStyle ?? '',
    preferredCta: knowledge.preferredCta ?? '',
    writingGuidelines: knowledge.writingGuidelines ?? '',
    prohibitedClaims: knowledge.prohibitedClaims,
    uniqueValueProps: knowledge.uniqueValueProps,
    products: knowledge.products,
    terminology: knowledge.terminology,
    authorBios: knowledge.authorBios,
  };
}

/** Empty strings are not answers: an untouched optional field is stored as null. */
function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function RepeaterHeader({
  title,
  description,
  onAdd,
  addLabel,
}: {
  title: string;
  description: string;
  onAdd: () => void;
  addLabel: string;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
      </div>
      <Button type="button" variant="outline" size="sm" className="h-8" onClick={onAdd}>
        <Plus aria-hidden="true" />
        {addLabel}
      </Button>
    </div>
  );
}

export interface KnowledgeTabProps {
  websiteId: string;
  knowledge: KnowledgeBaseData;
}

export function KnowledgeTab({ websiteId, knowledge }: KnowledgeTabProps): React.JSX.Element {
  const ids = useId();
  const { pending, run } = useSaveHandler();
  const [draft, setDraft] = useState<Draft>(() => toDraft(knowledge));

  const original = toDraft(knowledge);
  const dirty = !isSame(draft, original);

  const set = useCallback(<K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  }, []);

  const save = useCallback(() => {
    void run(async () => {
      const result = await saveKnowledgeBase({
        websiteId,
        businessDescription: orNull(draft.businessDescription),
        audience: orNull(draft.audience),
        toneOfVoice: orNull(draft.toneOfVoice),
        brandStyle: orNull(draft.brandStyle),
        preferredCta: orNull(draft.preferredCta),
        writingGuidelines: orNull(draft.writingGuidelines),
        prohibitedClaims: draft.prohibitedClaims,
        uniqueValueProps: draft.uniqueValueProps,
        products: draft.products.filter((product) => product.name.trim().length > 0),
        terminology: draft.terminology.filter(
          (term) => term.term.trim().length > 0 && term.definition.trim().length > 0,
        ),
        authorBios: draft.authorBios.filter((author) => author.name.trim().length > 0),
      });
      if (!result.ok) throw new Error(result.error);
    }, 'Knowledge base saved');
  }, [draft, run, websiteId]);

  return (
    <div className="space-y-6">
      <Alert variant="neutral" icon={BookOpen}>
        <AlertTitle>What reads this</AlertTitle>
        <AlertDescription>
          The content strategy, writer and refresh agents. Briefs and drafts are generated from
          this material plus the site&rsquo;s verified brand facts — so a thin knowledge base
          produces generic copy, and a wrong one produces confidently wrong copy.
        </AlertDescription>
      </Alert>

      <SettingsSection
        title="Knowledge base"
        description="Voice, positioning and vocabulary for anything written about this site."
        dirty={dirty}
        pending={pending}
        onSave={save}
        onReset={() => setDraft(toDraft(knowledge))}
        footerNote={
          knowledge.isEmpty
            ? 'Nothing has been filled in yet — content agents currently have no material to work from.'
            : `${knowledge.completeness}% of the eleven sections hold something.`
        }
      >
        {!dirty ? (
          <ProgressBar
            label="Sections filled"
            ariaLabel="Share of knowledge base sections that hold content"
            value={knowledge.completeness}
            max={100}
            tone={knowledge.completeness >= 70 ? 'success' : knowledge.completeness >= 30 ? 'warning' : 'muted'}
            formatValue={(value) => `${value}%`}
          />
        ) : null}

        <FormField
          label="Business description"
          htmlFor={`${ids}-business`}
          description="What the business actually does, in plain language. This is the single most-used field: it anchors every brief."
        >
          <Textarea
            id={`${ids}-business`}
            rows={4}
            value={draft.businessDescription}
            onChange={(event) => set('businessDescription', event.target.value)}
          />
        </FormField>

        <div className="grid gap-5 md:grid-cols-2">
          <FormField
            label="Audience"
            htmlFor={`${ids}-audience`}
            description="Who reads the site, and what they already know. Sets reading level and how much is explained."
          >
            <Textarea
              id={`${ids}-audience`}
              rows={3}
              value={draft.audience}
              onChange={(event) => set('audience', event.target.value)}
            />
          </FormField>

          <FormField
            label="Tone of voice"
            htmlFor={`${ids}-tone`}
            description="How it should sound — direct, warm, technical, formal. Concrete adjectives beat abstractions here."
          >
            <Textarea
              id={`${ids}-tone`}
              rows={3}
              value={draft.toneOfVoice}
              onChange={(event) => set('toneOfVoice', event.target.value)}
            />
          </FormField>

          <FormField
            label="Brand style"
            htmlFor={`${ids}-style`}
            description="House rules a copy editor would enforce: capitalisation, oxford commas, British or American spelling, how the product is named."
          >
            <Textarea
              id={`${ids}-style`}
              rows={3}
              value={draft.brandStyle}
              onChange={(event) => set('brandStyle', event.target.value)}
            />
          </FormField>

          <FormField
            label="Writing guidelines"
            htmlFor={`${ids}-guidelines`}
            description="Anything else a writer must follow — structure, length, what a good intro looks like."
          >
            <Textarea
              id={`${ids}-guidelines`}
              rows={3}
              value={draft.writingGuidelines}
              onChange={(event) => set('writingGuidelines', event.target.value)}
            />
          </FormField>
        </div>

        <FormField
          label="Preferred call to action"
          htmlFor={`${ids}-cta`}
          description="The action a page should ask for, worded the way you want it worded."
        >
          <Input
            id={`${ids}-cta`}
            value={draft.preferredCta}
            onChange={(event) => set('preferredCta', event.target.value)}
            placeholder="Start a free 14-day trial"
          />
        </FormField>

        <div className="grid gap-5 md:grid-cols-2">
          <ListField
            id={`${ids}-values`}
            label="Value propositions"
            value={draft.uniqueValueProps}
            onChange={(value) => set('uniqueValueProps', value)}
            placeholder={'Set up in under ten minutes\nNo per-seat pricing'}
            description="One per line. Writers lead with these; they are claims about you, so keep them true and specific."
          />

          <ListField
            id={`${ids}-prohibited`}
            label="Prohibited claims"
            value={draft.prohibitedClaims}
            onChange={(value) => set('prohibitedClaims', value)}
            placeholder={'Never say “guaranteed rankings”\nNo medical outcome claims'}
            description="One per line. Hard limits — legal, regulatory or reputational. A draft that trips one of these is held for review rather than published."
          />
        </div>
      </SettingsSection>

      <SettingsSection
        title="Products, terminology and authors"
        description="The specifics a writer would otherwise have to guess at."
        dirty={dirty}
        pending={pending}
        onSave={save}
        onReset={() => setDraft(toDraft(knowledge))}
        footerNote="Saved together with the fields above."
      >
        <div className="space-y-3">
          <RepeaterHeader
            title="Products and services"
            description="What can be mentioned by name, and where each one lives."
            addLabel="Add product"
            onAdd={() => set('products', [...draft.products, { name: '' }])}
          />

          {draft.products.length === 0 ? (
            <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
              No products listed. Drafts will describe the business generically rather than naming
              what you sell.
            </p>
          ) : (
            <ul className="space-y-2">
              {draft.products.map((product, index) => (
                <li key={index} className="grid gap-2 rounded-md border border-border p-3 md:grid-cols-[1fr_1fr_auto]">
                  <Input
                    value={product.name}
                    aria-label={`Product ${index + 1} name`}
                    placeholder="Name"
                    onChange={(event) =>
                      set(
                        'products',
                        draft.products.map((entry, position) =>
                          position === index ? { ...entry, name: event.target.value } : entry,
                        ),
                      )
                    }
                  />
                  <Input
                    value={product.url ?? ''}
                    aria-label={`Product ${index + 1} URL`}
                    placeholder="https://example.com/product"
                    className="font-mono text-xs"
                    onChange={(event) =>
                      set(
                        'products',
                        draft.products.map((entry, position) =>
                          position === index ? { ...entry, url: event.target.value } : entry,
                        ),
                      )
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove product ${index + 1}`}
                    onClick={() =>
                      set(
                        'products',
                        draft.products.filter((_, position) => position !== index),
                      )
                    }
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                  <Input
                    value={product.description ?? ''}
                    aria-label={`Product ${index + 1} description`}
                    placeholder="One line on what it does"
                    className="md:col-span-3"
                    onChange={(event) =>
                      set(
                        'products',
                        draft.products.map((entry, position) =>
                          position === index ? { ...entry, description: event.target.value } : entry,
                        ),
                      )
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="space-y-3">
          <RepeaterHeader
            title="Terminology"
            description="Words this business uses in a particular way, so a writer does not paraphrase them into something else."
            addLabel="Add term"
            onAdd={() => set('terminology', [...draft.terminology, { term: '', definition: '' }])}
          />

          {draft.terminology.length === 0 ? (
            <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
              No terminology recorded.
            </p>
          ) : (
            <ul className="space-y-2">
              {draft.terminology.map((term, index) => (
                <li key={index} className="grid gap-2 rounded-md border border-border p-3 md:grid-cols-[minmax(0,220px)_1fr_auto]">
                  <Input
                    value={term.term}
                    aria-label={`Term ${index + 1}`}
                    placeholder="Term"
                    onChange={(event) =>
                      set(
                        'terminology',
                        draft.terminology.map((entry, position) =>
                          position === index ? { ...entry, term: event.target.value } : entry,
                        ),
                      )
                    }
                  />
                  <Input
                    value={term.definition}
                    aria-label={`Definition of term ${index + 1}`}
                    placeholder="What it means here"
                    onChange={(event) =>
                      set(
                        'terminology',
                        draft.terminology.map((entry, position) =>
                          position === index ? { ...entry, definition: event.target.value } : entry,
                        ),
                      )
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove term ${index + 1}`}
                    onClick={() =>
                      set(
                        'terminology',
                        draft.terminology.filter((_, position) => position !== index),
                      )
                    }
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="space-y-3">
          <RepeaterHeader
            title="Author bios"
            description="Real people who can be credited. The pipeline will not invent a byline: with none listed, drafts publish without an author."
            addLabel="Add author"
            onAdd={() => set('authorBios', [...draft.authorBios, { name: '' }])}
          />

          {draft.authorBios.length === 0 ? (
            <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
              No authors listed. Drafts will carry no byline, which weakens author-level E-E-A-T
              signals.
            </p>
          ) : (
            <ul className="space-y-2">
              {draft.authorBios.map((author, index) => (
                <li key={index} className="grid gap-2 rounded-md border border-border p-3 md:grid-cols-[1fr_1fr_auto]">
                  <Input
                    value={author.name}
                    aria-label={`Author ${index + 1} name`}
                    placeholder="Full name"
                    onChange={(event) =>
                      set(
                        'authorBios',
                        draft.authorBios.map((entry, position) =>
                          position === index ? { ...entry, name: event.target.value } : entry,
                        ),
                      )
                    }
                  />
                  <Input
                    value={author.title ?? ''}
                    aria-label={`Author ${index + 1} title`}
                    placeholder="Role or title"
                    onChange={(event) =>
                      set(
                        'authorBios',
                        draft.authorBios.map((entry, position) =>
                          position === index ? { ...entry, title: event.target.value } : entry,
                        ),
                      )
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove author ${index + 1}`}
                    onClick={() =>
                      set(
                        'authorBios',
                        draft.authorBios.filter((_, position) => position !== index),
                      )
                    }
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                  <Textarea
                    rows={2}
                    value={author.bio ?? ''}
                    aria-label={`Author ${index + 1} bio`}
                    placeholder="A sentence of relevant credentials"
                    className="md:col-span-3"
                    onChange={(event) =>
                      set(
                        'authorBios',
                        draft.authorBios.map((entry, position) =>
                          position === index ? { ...entry, bio: event.target.value } : entry,
                        ),
                      )
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </SettingsSection>
    </div>
  );
}
