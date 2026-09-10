'use client';

import * as React from 'react';
import { ArrowRight, Store } from 'lucide-react';
import { createWebsiteSchema } from '@seo/shared/validation';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { saveBusinessStep } from './actions';
import { StepFooter, StepHeader } from './step-shell';
import type { OnboardingWebsite } from './types';

const businessFormSchema = createWebsiteSchema.pick({
  description: true,
  targetAudience: true,
  conversionGoal: true,
  brandName: true,
});

interface StepBusinessProps {
  site: OnboardingWebsite;
  onSaved: (site: OnboardingWebsite) => void;
  onNext: () => void;
  onBack: () => void;
}

/**
 * Business context.
 *
 * This is the single highest-leverage step for output quality: the content agents refuse to
 * assert anything they cannot ground, so a site with no description gets cautious, generic
 * drafts. Skipping is still allowed — it just costs specificity, and it says so.
 */
export function StepBusiness({ site, onSaved, onNext, onBack }: StepBusinessProps) {
  const [description, setDescription] = React.useState(site.description);
  const [audience, setAudience] = React.useState(site.targetAudience);
  const [goal, setGoal] = React.useState(site.conversionGoal);
  const [brand, setBrand] = React.useState(site.brandName);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);

    const parsed = businessFormSchema.safeParse({
      description,
      targetAudience: audience,
      conversionGoal: goal,
      brandName: brand,
    });

    if (!parsed.success) {
      const errors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path.join('.');
        if (key && !errors[key]) errors[key] = issue.message;
      }
      setFieldErrors(errors);
      return;
    }

    setFieldErrors({});
    setSaving(true);
    const result = await saveBusinessStep({ ...parsed.data, websiteId: site.id });
    setSaving(false);

    if (!result.ok) {
      setFieldErrors(result.fieldErrors ?? {});
      setFormError(result.error);
      return;
    }

    onSaved({
      ...site,
      description: parsed.data.description ?? '',
      targetAudience: parsed.data.targetAudience ?? '',
      conversionGoal: parsed.data.conversionGoal ?? '',
      brandName: parsed.data.brandName ?? '',
    });
    onNext();
  };

  return (
    <form onSubmit={submit} noValidate>
      <StepHeader
        icon={Store}
        title="Describe the business"
        description="Grounding for every brief, draft and recommendation. Skippable — the agents simply stay more generic without it."
      />

      <div className="mt-6 space-y-4">
        {formError ? (
          <Alert variant="destructive">
            <AlertDescription className="text-foreground">{formError}</AlertDescription>
          </Alert>
        ) : null}

        <FormField
          label="What does this business do?"
          description="Two or three sentences. What you sell, to whom, and what makes it different."
          error={fieldErrors.description}
        >
          <Textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={4}
            maxLength={2000}
            placeholder="Acme is a workforce scheduling tool for independent restaurant groups. We replace spreadsheet rotas with…"
            disabled={saving}
          />
        </FormField>

        <FormField
          label="Who are you trying to reach?"
          description="The reader a page should be written for."
          error={fieldErrors.targetAudience}
        >
          <Textarea
            value={audience}
            onChange={(event) => setAudience(event.target.value)}
            rows={3}
            maxLength={500}
            placeholder="Operations managers at 3–20 site restaurant groups, usually non-technical, evaluating tools themselves."
            disabled={saving}
          />
        </FormField>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label="Primary conversion goal"
            description="What a successful visit ends in."
            error={fieldErrors.conversionGoal}
          >
            <Input
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              maxLength={500}
              placeholder="Free trial signup"
              disabled={saving}
            />
          </FormField>

          <FormField
            label="Brand name"
            description="Used for brand queries and AI-visibility tracking."
            error={fieldErrors.brandName}
          >
            <Input
              value={brand}
              onChange={(event) => setBrand(event.target.value)}
              maxLength={120}
              placeholder="Acme"
              disabled={saving}
            />
          </FormField>
        </div>
      </div>

      <StepFooter onBack={onBack} onSkip={onNext}>
        <Button type="submit" loading={saving} loadingText="Saving details">
          Save and continue
          <ArrowRight aria-hidden="true" />
        </Button>
      </StepFooter>
    </form>
  );
}
