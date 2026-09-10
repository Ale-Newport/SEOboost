'use client';

import { useCallback, useId, useState } from 'react';

import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { apiPatch } from '@/lib/api-client';
import { SettingsSection, isSame, outsideRange, useSaveHandler } from '@/components/site-settings/settings-form';
import type { ThresholdSettings } from '@/components/site-settings/types';

/**
 * The three numbers that decide what counts as a problem or an opportunity on this site.
 *
 * They are per-site because the right answer is per-site: 300 words is thin for a guide and
 * generous for a product page. Each field says exactly which report changes when you move it, so
 * the effect of an edit is never a surprise.
 */

export interface ThresholdsTabProps {
  websiteId: string;
  thresholds: ThresholdSettings;
}

export function ThresholdsTab({ websiteId, thresholds }: ThresholdsTabProps): React.JSX.Element {
  const ids = useId();
  const { pending, run } = useSaveHandler();
  const [draft, setDraft] = useState<ThresholdSettings>(thresholds);

  const dirty = !isSame(draft, thresholds);

  const set = useCallback(<K extends keyof ThresholdSettings>(key: K, value: ThresholdSettings[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  }, []);

  const outOfRange =
    outsideRange(draft.thinContentWords, 50, 3000) ||
    outsideRange(draft.ctrOpportunityMinImpressions, 1, 1_000_000) ||
    outsideRange(draft.strikingDistanceMin, 1, 100) ||
    outsideRange(draft.strikingDistanceMax, 1, 100);
  // Only meaningful once both ends are real numbers; a cleared field is already caught above.
  const bandInvalid = !outOfRange && draft.strikingDistanceMin >= draft.strikingDistanceMax;

  const save = useCallback(() => {
    void run(() => apiPatch(`/api/websites/${websiteId}/settings`, draft), 'Thresholds saved');
  }, [draft, run, websiteId]);

  return (
    <SettingsSection
      title="Thresholds"
      description="Where the line falls between “fine” and “worth acting on” for this site."
      dirty={dirty}
      pending={pending}
      onSave={save}
      onReset={() => setDraft(thresholds)}
      blockedReason={
        outOfRange
          ? 'One or more values are empty or outside the allowed range.'
          : bandInvalid
            ? 'The striking-distance window must start before it ends.'
            : null
      }
      footerNote="Changing a threshold re-classifies existing pages and queries the next time analysis runs; it does not rewrite past reports."
    >
      <FormField
        label="Thin content"
        htmlFor={`${ids}-thin`}
        description="A page with fewer body words than this is flagged as thin. Raise it for long-form editorial sites; lower it for catalogues and reference pages, where a short page is the correct page and a flag would be noise."
      >
        <div className="flex items-center gap-2">
          <Input
            id={`${ids}-thin`}
            type="number"
            min={50}
            max={3000}
            step={10}
            value={Number.isFinite(draft.thinContentWords) ? draft.thinContentWords : ''}
            onChange={(event) => set('thinContentWords', Number(event.target.value))}
            className="md:w-40"
          />
          <span className="text-xs text-muted-foreground">words</span>
        </div>
      </FormField>

      <FormField
        label="CTR opportunity minimum impressions"
        htmlFor={`${ids}-ctr`}
        description="A query is only considered for a click-through-rate opportunity once it has this many impressions in the window. It is a noise filter: at 20 impressions, one extra click looks like a 5-point CTR swing, and the opportunity list fills with statistical accidents."
      >
        <div className="flex items-center gap-2">
          <Input
            id={`${ids}-ctr`}
            type="number"
            min={1}
            max={1_000_000}
            step={10}
            value={
              Number.isFinite(draft.ctrOpportunityMinImpressions)
                ? draft.ctrOpportunityMinImpressions
                : ''
            }
            onChange={(event) => set('ctrOpportunityMinImpressions', Number(event.target.value))}
            className="md:w-40"
          />
          <span className="text-xs text-muted-foreground">impressions</span>
        </div>
      </FormField>

      <FormField
        label="Striking distance band"
        htmlFor={`${ids}-striking-min`}
        description="Average positions counted as “close enough that focused work can realistically reach page one”. Widening the band adds more candidates and dilutes the list; narrowing it keeps only the queries a single on-page fix could move."
        error={bandInvalid ? 'The start of the band must be a better (lower) position than its end.' : undefined}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id={`${ids}-striking-min`}
            type="number"
            min={1}
            max={100}
            step={0.5}
            value={Number.isFinite(draft.strikingDistanceMin) ? draft.strikingDistanceMin : ''}
            onChange={(event) => set('strikingDistanceMin', Number(event.target.value))}
            aria-label="Best position in the striking-distance band"
            className="w-28"
          />
          <span className="text-xs text-muted-foreground">to</span>
          <Input
            type="number"
            min={1}
            max={100}
            step={0.5}
            value={Number.isFinite(draft.strikingDistanceMax) ? draft.strikingDistanceMax : ''}
            onChange={(event) => set('strikingDistanceMax', Number(event.target.value))}
            aria-label="Worst position in the striking-distance band"
            className="w-28"
          />
          <span className="text-xs text-muted-foreground">average position</span>
        </div>
      </FormField>
    </SettingsSection>
  );
}
