'use client';

import { useCallback, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError, apiDelete, apiPatch } from '@/lib/api-client';
import { AutonomySummary } from '@/components/automations/autonomy-selector';
import { ListField, SettingsSection, isSame, useSaveHandler } from '@/components/site-settings/settings-form';
import {
  CMS_TYPES,
  WEBSITE_STATUSES,
  WEBSITE_STATUS_COPY,
  type SiteProfile,
} from '@/components/site-settings/types';

/**
 * Who this site is, in the platform's own words.
 *
 * These fields are not decoration: the content agents read the brand name, audience, conversion
 * goal and category, and the locale fields decide which market a keyword or a SERP is judged in.
 * Each one says what reads it, so a blank field is a visible gap rather than an optional extra.
 */

interface Draft {
  name: string;
  domain: string;
  protocol: string;
  status: string;
  cmsType: string;
  primaryLanguage: string;
  targetCountry: string;
  targetLocales: string[];
  description: string;
  businessCategory: string;
  targetAudience: string;
  conversionGoal: string;
  brandName: string;
}

function toDraft(site: SiteProfile): Draft {
  return {
    name: site.name,
    domain: site.domain,
    protocol: site.protocol,
    status: site.status,
    cmsType: site.cmsType,
    primaryLanguage: site.primaryLanguage,
    targetCountry: site.targetCountry,
    targetLocales: site.targetLocales,
    description: site.description ?? '',
    businessCategory: site.businessCategory ?? '',
    targetAudience: site.targetAudience ?? '',
    conversionGoal: site.conversionGoal ?? '',
    brandName: site.brandName ?? '',
  };
}

/** `SHOPIFY` → `Shopify`, `NEXTJS` → `Next.js`. */
const CMS_LABEL: Record<string, string> = {
  UNKNOWN: 'Not known yet',
  WORDPRESS: 'WordPress',
  SHOPIFY: 'Shopify',
  WEBFLOW: 'Webflow',
  NEXTJS: 'Next.js',
  ASTRO: 'Astro',
  HUGO: 'Hugo',
  GHOST: 'Ghost',
  SQUARESPACE: 'Squarespace',
  WIX: 'Wix',
  CUSTOM: 'Custom / in-house',
  GIT: 'Files in a Git repository',
};

export interface GeneralTabProps {
  site: SiteProfile;
  autonomyLevel: string;
}

export function GeneralTab({ site, autonomyLevel }: GeneralTabProps): React.JSX.Element {
  const router = useRouter();
  const ids = useId();
  const { pending, run } = useSaveHandler();
  const [draft, setDraft] = useState<Draft>(() => toDraft(site));
  const [deleteOpen, setDeleteOpen] = useState(false);

  const original = toDraft(site);
  const dirty = !isSame(draft, original);

  const set = useCallback(<K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  }, []);

  const save = useCallback(() => {
    void run(
      () =>
        apiPatch(`/api/websites/${site.id}`, {
          name: draft.name.trim(),
          domain: draft.domain.trim(),
          protocol: draft.protocol,
          status: draft.status,
          cmsType: draft.cmsType,
          primaryLanguage: draft.primaryLanguage.trim(),
          targetCountry: draft.targetCountry.trim(),
          targetLocales: draft.targetLocales,
          description: draft.description.trim(),
          businessCategory: draft.businessCategory.trim(),
          targetAudience: draft.targetAudience.trim(),
          conversionGoal: draft.conversionGoal.trim(),
          brandName: draft.brandName.trim(),
        }),
      'Site profile saved',
    );
  }, [draft, run, site.id]);

  const remove = useCallback(async () => {
    try {
      await apiDelete(`/api/websites/${site.id}?confirm=${encodeURIComponent(site.domain)}`);
      toast.success(`${site.domain} deleted`, {
        description: 'Every crawl, page, keyword, action and change record for it is gone.',
      });
      router.push('/sites');
      router.refresh();
    } catch (cause) {
      toast.error('Could not delete this website', {
        description: cause instanceof ApiError ? cause.message : 'The site was left untouched.',
      });
      // Rethrown so the dialog stays open with the failure visible.
      throw cause;
    }
  }, [router, site.domain, site.id]);

  const invalidLocales = draft.targetLocales.some((locale) => locale.length < 2 || locale.length > 10);
  const language = draft.primaryLanguage.trim();
  const country = draft.targetCountry.trim();
  const blockedReason =
    draft.name.trim().length === 0
      ? 'The site needs a name.'
      : draft.domain.trim().length === 0
        ? 'The site needs a domain.'
        : language.length < 2 || language.length > 10
          ? 'The primary language is an ISO code such as en or pt-BR.'
          : country.length < 2 || country.length > 3
            ? 'The target country is a 2- or 3-letter code such as US or USA.'
            : invalidLocales
              ? 'Locales are BCP-47 tags such as en-US or de-DE — between 2 and 10 characters each.'
              : null;

  return (
    <div className="space-y-6">
      <SettingsSection
        title="Site profile"
        description="Identity and market. The content and keyword agents read these fields directly."
        dirty={dirty}
        pending={pending}
        onSave={save}
        onReset={() => setDraft(toDraft(site))}
        blockedReason={dirty ? blockedReason : null}
      >
        <div className="grid gap-5 md:grid-cols-2">
          <FormField
            label="Name"
            htmlFor={`${ids}-name`}
            description="What this site is called inside the platform. Only you see it."
            required
          >
            <Input
              id={`${ids}-name`}
              value={draft.name}
              onChange={(event) => set('name', event.target.value)}
              autoComplete="off"
            />
          </FormField>

          <FormField
            label="Brand name"
            htmlFor={`${ids}-brand`}
            description="The name a writer should use in copy. Left empty, drafts fall back to the site name."
          >
            <Input
              id={`${ids}-brand`}
              value={draft.brandName}
              onChange={(event) => set('brandName', event.target.value)}
              autoComplete="off"
            />
          </FormField>

          <FormField
            label="Domain"
            htmlFor={`${ids}-domain`}
            description="Bare hostname, without the scheme or a trailing path. Changing it re-points every crawl and Search Console match."
            required
          >
            <Input
              id={`${ids}-domain`}
              value={draft.domain}
              onChange={(event) => set('domain', event.target.value)}
              className="font-mono"
              spellCheck={false}
              autoComplete="off"
              placeholder="example.com"
            />
          </FormField>

          <FormField
            label="Protocol"
            htmlFor={`${ids}-protocol`}
            description="How the crawler reaches the site. HTTPS unless the site genuinely has no certificate."
          >
            <Select value={draft.protocol} onValueChange={(value) => set('protocol', value)}>
              <SelectTrigger id={`${ids}-protocol`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="https">https</SelectItem>
                <SelectItem value="http">http</SelectItem>
              </SelectContent>
            </Select>
          </FormField>

          <FormField
            label="Primary language"
            htmlFor={`${ids}-language`}
            description="ISO code of the language most pages are written in, e.g. en, de, es."
          >
            <Input
              id={`${ids}-language`}
              value={draft.primaryLanguage}
              onChange={(event) => set('primaryLanguage', event.target.value)}
              className="font-mono"
              spellCheck={false}
              autoComplete="off"
              placeholder="en"
            />
          </FormField>

          <FormField
            label="Target country"
            htmlFor={`${ids}-country`}
            description="Country code used when a SERP or a keyword volume has to be requested for one market."
          >
            <Input
              id={`${ids}-country`}
              value={draft.targetCountry}
              onChange={(event) => set('targetCountry', event.target.value)}
              className="font-mono"
              spellCheck={false}
              autoComplete="off"
              placeholder="USA"
            />
          </FormField>
        </div>

        <ListField
          id={`${ids}-locales`}
          label="Target locales"
          description="One BCP-47 tag per line (en-US, en-GB, de-DE). Rankings and content are judged per locale, so add every market you actually serve."
          value={draft.targetLocales}
          onChange={(value) => set('targetLocales', value)}
          placeholder={'en-US\nen-GB'}
        />

        <div className="grid gap-5 md:grid-cols-2">
          <FormField
            label="Business category"
            htmlFor={`${ids}-category`}
            description="Sets the competitive frame — “B2B SaaS”, “independent bakery”, “law firm”."
          >
            <Input
              id={`${ids}-category`}
              value={draft.businessCategory}
              onChange={(event) => set('businessCategory', event.target.value)}
              autoComplete="off"
            />
          </FormField>

          <FormField
            label="CMS"
            htmlFor={`${ids}-cms`}
            description="Decides which adapter can publish a change. Set it before you expect an action to apply itself."
          >
            <Select value={draft.cmsType} onValueChange={(value) => set('cmsType', value)}>
              <SelectTrigger id={`${ids}-cms`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CMS_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {CMS_LABEL[type] ?? type}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>

          <FormField
            label="Target audience"
            htmlFor={`${ids}-audience`}
            description="Who the copy is for. Writers use it to pitch reading level and vocabulary."
          >
            <Input
              id={`${ids}-audience`}
              value={draft.targetAudience}
              onChange={(event) => set('targetAudience', event.target.value)}
              autoComplete="off"
            />
          </FormField>

          <FormField
            label="Conversion goal"
            htmlFor={`${ids}-goal`}
            description="What a visit is meant to lead to — a trial, a booking, a purchase. Used to weigh business value when actions are prioritised."
          >
            <Input
              id={`${ids}-goal`}
              value={draft.conversionGoal}
              onChange={(event) => set('conversionGoal', event.target.value)}
              autoComplete="off"
            />
          </FormField>
        </div>

        <FormField
          label="Description"
          htmlFor={`${ids}-description`}
          description="A sentence or two about the site, for your own reference and as background for agents."
        >
          <Input
            id={`${ids}-description`}
            value={draft.description}
            onChange={(event) => set('description', event.target.value)}
            autoComplete="off"
          />
        </FormField>

        <FormField
          label="Status"
          htmlFor={`${ids}-status`}
          description={WEBSITE_STATUS_COPY[draft.status] ?? 'Controls whether scheduled work runs.'}
        >
          <Select value={draft.status} onValueChange={(value) => set('status', value)}>
            <SelectTrigger id={`${ids}-status`} className="md:w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WEBSITE_STATUSES.map((status) => (
                <SelectItem key={status} value={status}>
                  {status.charAt(0) + status.slice(1).toLowerCase()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      </SettingsSection>

      <Card>
        <CardHeader>
          <CardTitle>Autonomy</CardTitle>
          <CardDescription>
            How much this site&rsquo;s AI may do without you. Edited on the Automations screen,
            where the whole ladder and its guardrails are visible.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AutonomySummary autonomyLevel={autonomyLevel} />
        </CardContent>
      </Card>

      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-destructive">Delete this website</CardTitle>
          <CardDescription>
            Permanent, immediate and not recoverable from this app.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Alert variant="destructive" icon={Trash2}>
            <AlertTitle>What goes with it</AlertTitle>
            <AlertDescription>
              Every crawl, page, keyword, technical issue, content draft, action, approval,
              experiment and change-history entry for {site.domain}. Connected integrations are
              disconnected and the site&rsquo;s schedules are unregistered from the queue.
            </AlertDescription>
          </Alert>

          <Button variant="destructive" size="sm" onClick={() => setDeleteOpen(true)}>
            <Trash2 aria-hidden="true" />
            Delete {site.domain}
          </Button>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        destructive
        title={`Delete ${site.domain}?`}
        description="This removes the site and everything recorded against it. There is no undo, and no export is taken first."
        confirmLabel="Delete this website"
        confirmationText={site.domain}
        confirmationHint={
          <>
            Type <span className="font-mono font-medium text-foreground">{site.domain}</span> to
            confirm.
          </>
        }
        onConfirm={remove}
      />
    </div>
  );
}
