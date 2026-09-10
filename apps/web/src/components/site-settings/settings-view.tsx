'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { ExternalLink } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AiTab } from '@/components/site-settings/ai-tab';
import { BrandFactsTab } from '@/components/site-settings/brand-facts-tab';
import { CrawlerTab } from '@/components/site-settings/crawler-tab';
import { GeneralTab } from '@/components/site-settings/general-tab';
import { IntegrationsTab } from '@/components/site-settings/integrations-tab';
import { KnowledgeTab } from '@/components/site-settings/knowledge-tab';
import { ThresholdsTab } from '@/components/site-settings/thresholds-tab';
import type { SiteSettingsData } from '@/components/site-settings/types';

/**
 * The settings screen for one site.
 *
 * Tabs rather than one long page, and the active tab lives in `?tab=` so a link can point at
 * "the crawler settings for this site". The URL is updated with `history.replaceState` rather
 * than a router navigation: switching tabs is not new data, and a server round-trip would throw
 * away whatever is half-typed in another tab's form.
 */

const TABS = [
  { id: 'general', label: 'General' },
  { id: 'crawler', label: 'Crawler' },
  { id: 'ai', label: 'AI' },
  { id: 'knowledge', label: 'Knowledge base' },
  { id: 'brand-facts', label: 'Brand facts' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'thresholds', label: 'Thresholds' },
] as const;

type TabId = (typeof TABS)[number]['id'];

function isTabId(value: string): value is TabId {
  return TABS.some((tab) => tab.id === value);
}

export interface SettingsViewProps {
  data: SiteSettingsData;
  /** Tab from `?tab=`, already validated by the page. */
  initialTab: string;
}

export function SettingsView({ data, initialTab }: SettingsViewProps): React.JSX.Element {
  const [tab, setTab] = useState<TabId>(isTabId(initialTab) ? initialTab : 'general');
  const { site } = data;
  const siteUrl = `${site.protocol}://${site.domain}`;

  const connectedIntegrations = data.integrations.filter((row) => row.hasCredentials).length;
  const integrationErrors = data.integrations.filter((row) => row.status === 'ERROR').length;

  const changeTab = useCallback((value: string) => {
    if (!isTabId(value)) return;
    setTab(value);
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (value === 'general') url.searchParams.delete('tab');
    else url.searchParams.set('tab', value);
    window.history.replaceState(null, '', url.toString());
  }, []);

  return (
    <div className="space-y-6 px-4 py-6 md:px-6">
      <PageHeader
        title="Settings"
        description={
          <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
            <a
              href={siteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 hover:text-foreground hover:underline"
            >
              {site.domain}
              <ExternalLink aria-hidden="true" className="size-3" />
            </a>
            <span aria-hidden="true">·</span>
            <span>{site.name}</span>
          </span>
        }
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href={`/sites/${site.id}/automations`}>Automations</Link>
          </Button>
        }
      />

      <Tabs value={tab} onValueChange={changeTab}>
        <TabsList className="overflow-x-auto">
          {TABS.map((entry) => (
            <TabsTrigger key={entry.id} value={entry.id}>
              {entry.label}
              {entry.id === 'brand-facts' && data.brandFactCounts.unverified > 0 ? (
                <Badge variant="warning" className="ml-1.5 font-normal">
                  {data.brandFactCounts.unverified}
                </Badge>
              ) : null}
              {entry.id === 'integrations' ? (
                <Badge
                  variant={integrationErrors > 0 ? 'destructive' : 'muted'}
                  className="ml-1.5 font-normal"
                >
                  {integrationErrors > 0 ? `${integrationErrors} error` : connectedIntegrations}
                </Badge>
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="general" className="mt-5">
          <GeneralTab site={site} autonomyLevel={data.autonomyLevel} />
        </TabsContent>

        <TabsContent value="crawler" className="mt-5">
          <CrawlerTab websiteId={site.id} crawler={data.crawler} />
        </TabsContent>

        <TabsContent value="ai" className="mt-5">
          <AiTab
            websiteId={site.id}
            ai={data.ai}
            providers={data.providers}
            defaults={data.aiDefaults}
          />
        </TabsContent>

        <TabsContent value="knowledge" className="mt-5">
          <KnowledgeTab websiteId={site.id} knowledge={data.knowledge} />
        </TabsContent>

        <TabsContent value="brand-facts" className="mt-5">
          <BrandFactsTab
            websiteId={site.id}
            facts={data.brandFacts}
            counts={data.brandFactCounts}
          />
        </TabsContent>

        <TabsContent value="integrations" className="mt-5">
          <IntegrationsTab websiteId={site.id} integrations={data.integrations} />
        </TabsContent>

        <TabsContent value="thresholds" className="mt-5">
          <ThresholdsTab websiteId={site.id} thresholds={data.thresholds} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
