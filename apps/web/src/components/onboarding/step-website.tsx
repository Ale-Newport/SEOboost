'use client';

import * as React from 'react';
import { ArrowRight, Globe } from 'lucide-react';
import { createWebsiteSchema, domainSchema } from '@seo/shared/validation';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { saveWebsiteStep } from './actions';
import { StepFooter, StepHeader } from './step-shell';
import type { OnboardingWebsite } from './types';

/** The same `pick` the server action validates with, so both sides reject identically. */
const websiteFormSchema = createWebsiteSchema.pick({
  name: true,
  domain: true,
  protocol: true,
  primaryLanguage: true,
  targetCountry: true,
  businessCategory: true,
});

const LANGUAGES: Array<{ value: string; label: string }> = [
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'it', label: 'Italian' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'nl', label: 'Dutch' },
  { value: 'sv', label: 'Swedish' },
  { value: 'da', label: 'Danish' },
  { value: 'nb', label: 'Norwegian' },
  { value: 'fi', label: 'Finnish' },
  { value: 'pl', label: 'Polish' },
  { value: 'tr', label: 'Turkish' },
  { value: 'ru', label: 'Russian' },
  { value: 'ar', label: 'Arabic' },
  { value: 'hi', label: 'Hindi' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'zh', label: 'Chinese' },
];

/** ISO-3166 alpha-3, the form Search Console reports countries in. */
const COUNTRIES: Array<{ value: string; label: string }> = [
  { value: 'USA', label: 'United States' },
  { value: 'GBR', label: 'United Kingdom' },
  { value: 'CAN', label: 'Canada' },
  { value: 'AUS', label: 'Australia' },
  { value: 'IRL', label: 'Ireland' },
  { value: 'DEU', label: 'Germany' },
  { value: 'FRA', label: 'France' },
  { value: 'ESP', label: 'Spain' },
  { value: 'ITA', label: 'Italy' },
  { value: 'NLD', label: 'Netherlands' },
  { value: 'BEL', label: 'Belgium' },
  { value: 'CHE', label: 'Switzerland' },
  { value: 'AUT', label: 'Austria' },
  { value: 'SWE', label: 'Sweden' },
  { value: 'NOR', label: 'Norway' },
  { value: 'DNK', label: 'Denmark' },
  { value: 'FIN', label: 'Finland' },
  { value: 'POL', label: 'Poland' },
  { value: 'PRT', label: 'Portugal' },
  { value: 'BRA', label: 'Brazil' },
  { value: 'MEX', label: 'Mexico' },
  { value: 'ARG', label: 'Argentina' },
  { value: 'IND', label: 'India' },
  { value: 'SGP', label: 'Singapore' },
  { value: 'JPN', label: 'Japan' },
  { value: 'KOR', label: 'South Korea' },
  { value: 'ARE', label: 'United Arab Emirates' },
  { value: 'ZAF', label: 'South Africa' },
  { value: 'NZL', label: 'New Zealand' },
];

const CATEGORY_SUGGESTIONS = [
  'SaaS',
  'E-commerce',
  'Marketplace',
  'Agency',
  'Professional services',
  'Local services',
  'Healthcare',
  'Finance',
  'Education',
  'Media & publishing',
  'Travel',
  'Real estate',
  'Non-profit',
];

interface StepWebsiteProps {
  site: OnboardingWebsite | null;
  onSaved: (site: OnboardingWebsite) => void;
  onNext: () => void;
  onBack: () => void;
}

/**
 * The only mandatory step. It runs before the rest so the remaining answers have a row to
 * attach to — a refresh or an OAuth redirect mid-setup then costs nothing.
 */
export function StepWebsite({ site, onSaved, onNext, onBack }: StepWebsiteProps) {
  const [name, setName] = React.useState(site?.name ?? '');
  const [domain, setDomain] = React.useState(site?.domain ?? '');
  const [protocol, setProtocol] = React.useState<'https' | 'http'>(site?.protocol ?? 'https');
  const [language, setLanguage] = React.useState(site?.primaryLanguage ?? 'en');
  const [country, setCountry] = React.useState(site?.targetCountry ?? 'USA');
  const [category, setCategory] = React.useState(site?.businessCategory ?? '');
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  // Reuse the schema's own normalisation for the preview rather than re-implementing it.
  const normalisedDomain = domainSchema.safeParse(domain);
  const preview = normalisedDomain.success ? `${protocol}://${normalisedDomain.data}` : null;

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);

    const parsed = websiteFormSchema.safeParse({
      name,
      domain,
      protocol,
      primaryLanguage: language,
      targetCountry: country,
      businessCategory: category,
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

    const result = await saveWebsiteStep({ ...parsed.data, websiteId: site?.id });
    setSaving(false);

    if (!result.ok) {
      setFieldErrors(result.fieldErrors ?? {});
      setFormError(result.error);
      return;
    }

    onSaved({
      id: result.data.websiteId,
      name: result.data.name,
      domain: result.data.domain,
      protocol: parsed.data.protocol,
      primaryLanguage: parsed.data.primaryLanguage,
      targetCountry: parsed.data.targetCountry,
      businessCategory: parsed.data.businessCategory ?? '',
      description: site?.description ?? '',
      targetAudience: site?.targetAudience ?? '',
      conversionGoal: site?.conversionGoal ?? '',
      brandName: site?.brandName ?? '',
      competitors: site?.competitors ?? [],
      searchConsoleConnected: site?.searchConsoleConnected ?? false,
    });
    onNext();
  };

  return (
    <form onSubmit={submit} noValidate>
      <StepHeader
        icon={Globe}
        title="Add your first website"
        description="Everything else in the product hangs off a site. You can add more at any time."
      />

      <div className="mt-6 space-y-4">
        {formError ? (
          <Alert variant="destructive">
            <AlertDescription className="text-foreground">{formError}</AlertDescription>
          </Alert>
        ) : null}

        <FormField label="Name" description="How this site appears in menus and reports." error={fieldErrors.name} required>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Acme Marketing Site"
            autoFocus
            disabled={saving}
          />
        </FormField>

        <div className="grid gap-4 sm:grid-cols-[8rem_minmax(0,1fr)]">
          <FormField label="Protocol" error={fieldErrors.protocol}>
            <Select
              value={protocol}
              onValueChange={(value) => setProtocol(value === 'http' ? 'http' : 'https')}
              disabled={saving}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="https">https</SelectItem>
                <SelectItem value="http">http</SelectItem>
              </SelectContent>
            </Select>
          </FormField>

          <FormField
            label="Domain"
            description={preview ? `The crawler will start at ${preview}` : 'Without www or a path, e.g. example.com'}
            error={fieldErrors.domain}
            required
          >
            <Input
              value={domain}
              onChange={(event) => setDomain(event.target.value)}
              placeholder="example.com"
              spellCheck={false}
              autoCapitalize="none"
              inputMode="url"
              disabled={saving}
            />
          </FormField>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label="Primary language"
            description="Used for readability scoring and content generation."
            error={fieldErrors.primaryLanguage}
          >
            <Select value={language} onValueChange={setLanguage} disabled={saving}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LANGUAGES.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>

          <FormField
            label="Target country"
            description="The market rankings and SERP checks are measured in."
            error={fieldErrors.targetCountry}
          >
            <Select value={country} onValueChange={setCountry} disabled={saving}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COUNTRIES.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        </div>

        <FormField
          label="Business category"
          description="Optional. Helps the agents pick the right page types and schema."
          error={fieldErrors.businessCategory}
        >
          <>
            <Input
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              list="onboarding-business-categories"
              placeholder="SaaS"
              disabled={saving}
            />
            <datalist id="onboarding-business-categories">
              {CATEGORY_SUGGESTIONS.map((suggestion) => (
                <option key={suggestion} value={suggestion} />
              ))}
            </datalist>
          </>
        </FormField>
      </div>

      <StepFooter onBack={onBack}>
        <Button type="submit" loading={saving} loadingText="Saving website">
          {site ? 'Save and continue' : 'Create website'}
          <ArrowRight aria-hidden="true" />
        </Button>
      </StepFooter>
    </form>
  );
}
