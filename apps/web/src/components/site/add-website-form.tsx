'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { createWebsiteSchema } from '@seo/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { apiPost, ApiError } from '@/lib/api-client';

const LANGUAGES = [
  ['en', 'English'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch'],
  ['it', 'Italiano'], ['pt', 'Português'], ['nl', 'Nederlands'], ['pl', 'Polski'],
  ['sv', 'Svenska'], ['ja', '日本語'], ['zh', '中文'],
] as const;

const COUNTRIES = [
  ['USA', 'United States'], ['GBR', 'United Kingdom'], ['ESP', 'Spain'], ['DEU', 'Germany'],
  ['FRA', 'France'], ['ITA', 'Italy'], ['NLD', 'Netherlands'], ['CAN', 'Canada'],
  ['AUS', 'Australia'], ['MEX', 'Mexico'], ['BRA', 'Brazil'], ['IND', 'India'],
] as const;

const CMS_OPTIONS = [
  ['UNKNOWN', 'Detect automatically'], ['WORDPRESS', 'WordPress'], ['SHOPIFY', 'Shopify'],
  ['WEBFLOW', 'Webflow'], ['NEXTJS', 'Next.js'], ['ASTRO', 'Astro'], ['HUGO', 'Hugo'],
  ['GHOST', 'Ghost'], ['SQUARESPACE', 'Squarespace'], ['WIX', 'Wix'], ['GIT', 'Git-based'],
  ['CUSTOM', 'Custom'],
] as const;

export function AddWebsiteForm() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [competitors, setCompetitors] = useState<string[]>([]);
  const [competitorDraft, setCompetitorDraft] = useState('');
  const [startCrawl, setStartCrawl] = useState(true);
  const [cmsType, setCmsType] = useState('UNKNOWN');
  const [language, setLanguage] = useState('en');
  const [country, setCountry] = useState('USA');

  const addCompetitor = () => {
    const value = competitorDraft.trim();
    if (!value) return;
    const cleaned = value.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, '').toLowerCase();
    if (competitors.includes(cleaned)) {
      setCompetitorDraft('');
      return;
    }
    if (competitors.length >= 20) {
      toast.warning('Twenty competitors is plenty — track the ones that actually compete.');
      return;
    }
    setCompetitors((prev) => [...prev, cleaned]);
    setCompetitorDraft('');
  };

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrors({});
    const formData = new FormData(event.currentTarget);

    const parsed = createWebsiteSchema.safeParse({
      name: formData.get('name'),
      domain: formData.get('domain'),
      protocol: formData.get('protocol') ?? 'https',
      description: formData.get('description') ?? '',
      businessCategory: formData.get('businessCategory') ?? '',
      targetAudience: formData.get('targetAudience') ?? '',
      conversionGoal: formData.get('conversionGoal') ?? '',
      brandName: formData.get('brandName') ?? '',
      primaryLanguage: language,
      targetLocales: [`${language}-${country.slice(0, 2)}`],
      targetCountry: country,
      cmsType,
      competitors,
      startCrawl,
    });

    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path.join('.');
        if (!fieldErrors[key]) fieldErrors[key] = issue.message;
      }
      setErrors(fieldErrors);
      toast.error('Check the highlighted fields.');
      return;
    }

    setSubmitting(true);
    try {
      const result = await apiPost<{ id: string; crawlEnqueued?: boolean }>('/api/websites', parsed.data);
      toast.success('Website added', {
        description: startCrawl
          ? result.crawlEnqueued === false
            ? 'The crawl is queued, but no worker is connected yet.'
            : 'The first crawl has started.'
          : undefined,
      });
      router.push(`/sites/${result.id}`);
      router.refresh();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setErrors({ domain: error.message });
      }
      toast.error(error instanceof ApiError ? error.message : 'Could not add the website');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>The basics</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <FormField label="Website name" error={errors.name} required>
            <Input name="name" placeholder="Acme Fitness" autoFocus required />
          </FormField>

          <FormField
            label="Domain"
            error={errors.domain}
            required
            description="Without https:// or www."
          >
            <Input name="domain" placeholder="acme.com" required inputMode="url" autoCapitalize="off" spellCheck={false} />
          </FormField>

          <FormField label="Brand name" error={errors.brandName} description="Used for entity and AI-visibility tracking.">
            <Input name="brandName" placeholder="Acme" />
          </FormField>

          <FormField label="Business category" error={errors.businessCategory}>
            <Input name="businessCategory" placeholder="Fitness software" />
          </FormField>

          <div className="space-y-1.5">
            <Label htmlFor="language">Primary language</Label>
            <Select value={language} onValueChange={setLanguage}>
              <SelectTrigger id="language"><SelectValue /></SelectTrigger>
              <SelectContent>
                {LANGUAGES.map(([code, label]) => (
                  <SelectItem key={code} value={code}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="country">Target market</Label>
            <Select value={country} onValueChange={setCountry}>
              <SelectTrigger id="country"><SelectValue /></SelectTrigger>
              <SelectContent>
                {COUNTRIES.map(([code, label]) => (
                  <SelectItem key={code} value={code}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="cms">CMS</Label>
            <Select value={cmsType} onValueChange={setCmsType}>
              <SelectTrigger id="cms"><SelectValue /></SelectTrigger>
              <SelectContent>
                {CMS_OPTIONS.map(([code, label]) => (
                  <SelectItem key={code} value={code}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              The crawler detects this automatically. Set it explicitly only if detection gets it wrong.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Context for the AI agents</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <FormField
            label="What does this business do?"
            error={errors.description}
            description="One or two paragraphs. Content and GEO agents rely on this heavily."
          >
            <Textarea name="description" rows={3} placeholder="Acme builds an AI workout planner for people training at home or in a commercial gym." />
          </FormField>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Target audience" error={errors.targetAudience}>
              <Input name="targetAudience" placeholder="Intermediate lifters aged 25-45" />
            </FormField>
            <FormField label="Primary conversion goal" error={errors.conversionGoal}>
              <Input name="conversionGoal" placeholder="Free trial signup" />
            </FormField>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Competitors</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input
              value={competitorDraft}
              onChange={(event) => setCompetitorDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addCompetitor();
                }
              }}
              placeholder="competitor.com"
              inputMode="url"
              autoCapitalize="off"
              spellCheck={false}
              aria-label="Competitor domain"
            />
            <Button type="button" variant="outline" onClick={addCompetitor}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Add
            </Button>
          </div>

          {competitors.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5">
              {competitors.map((domain) => (
                <li key={domain}>
                  <Badge variant="secondary" className="gap-1 pr-1">
                    {domain}
                    <button
                      type="button"
                      onClick={() => setCompetitors((prev) => prev.filter((d) => d !== domain))}
                      className="rounded-sm p-0.5 hover:bg-background/60"
                      aria-label={`Remove ${domain}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">
              Optional. The competitor agent can also discover them from SERP data if a provider is configured.
            </p>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-muted/30 p-4">
        <div className="min-w-0">
          <Label htmlFor="startCrawl" className="cursor-pointer">Crawl immediately</Label>
          <p className="text-xs text-muted-foreground">
            Discovers pages, runs the technical audit and builds the internal link graph. Needs the worker running.
          </p>
        </div>
        <Switch id="startCrawl" checked={startCrawl} onCheckedChange={setStartCrawl} />
      </div>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => router.back()} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Add website
        </Button>
      </div>
    </form>
  );
}
