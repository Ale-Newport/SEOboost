import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { APP_SETTING_PROVIDER_KEY, getAvailableProviders } from '@seo/ai';
import { getAppSetting, prisma } from '@seo/db';
import { env } from '@seo/shared';
import { OnboardingWizard } from '@/components/onboarding/onboarding-wizard';
import type { AiProviderOption, GoogleSetup, OnboardingWebsite } from '@/components/onboarding/types';
import { getCurrentUser } from '@/lib/auth';

export const metadata: Metadata = { title: 'Set up' };

/** Resume state comes from the database and the query string; nothing here may be cached. */
export const dynamic = 'force-dynamic';

/** Display names for the registry's provider keys. */
const PROVIDER_LABEL: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Google Gemini',
};

interface OnboardingPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function OnboardingPage({ searchParams }: OnboardingPageProps) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const params = await searchParams;
  const siteId = typeof params.site === 'string' ? params.site : undefined;
  const stepParam = typeof params.step === 'string' ? Number.parseInt(params.step, 10) : Number.NaN;

  /*
   * Resuming reads the site straight from the database rather than trusting anything in the
   * browser: the wizard writes each answer as it goes, so the row *is* the saved progress —
   * a refresh, a closed tab or the Google OAuth round trip all land back on real data.
   */
  const website = siteId
    ? await prisma.website.findFirst({
        where: { id: siteId, userId: user.id },
        select: {
          id: true,
          name: true,
          domain: true,
          protocol: true,
          primaryLanguage: true,
          targetCountry: true,
          businessCategory: true,
          description: true,
          targetAudience: true,
          conversionGoal: true,
          brandName: true,
          /*
           * Manual rows only. The competitor step replaces exactly the set it is shown, and
           * `saveCompetitors` deliberately never deletes SERP-discovered rows — so loading them
           * here would let the wizard silently re-file somebody else's discovery as a manual
           * entry, or drop it off the end of the five-row form.
           */
          competitors: {
            where: { isActive: true, isManual: true },
            select: { domain: true },
            orderBy: { domain: 'asc' },
          },
          integrations: {
            where: { provider: 'GOOGLE_SEARCH_CONSOLE' },
            select: { status: true },
          },
        },
      })
    : null;

  const site: OnboardingWebsite | null = website
    ? {
        id: website.id,
        name: website.name,
        domain: website.domain,
        protocol: website.protocol === 'http' ? 'http' : 'https',
        primaryLanguage: website.primaryLanguage,
        targetCountry: website.targetCountry,
        businessCategory: website.businessCategory ?? '',
        description: website.description ?? '',
        targetAudience: website.targetAudience ?? '',
        conversionGoal: website.conversionGoal ?? '',
        brandName: website.brandName ?? '',
        competitors: website.competitors.map((competitor) => competitor.domain),
        searchConsoleConnected: website.integrations.some((row) => row.status === 'CONNECTED'),
      }
    : null;

  const aiProviders: AiProviderOption[] = getAvailableProviders().map((provider) => ({
    name: provider.name,
    label: PROVIDER_LABEL[provider.name] ?? provider.name,
    configured: provider.configured,
    envVar: provider.envVar,
  }));

  const storedProvider = await getAppSetting<unknown>(APP_SETTING_PROVIDER_KEY, null);
  const defaultAiProvider =
    typeof storedProvider === 'string' ? storedProvider : (env.defaultAiProvider ?? null);

  const googleSetup: GoogleSetup = {
    configured: Boolean(env.googleClientId && env.googleClientSecret),
    missingEnvVars: [
      ...(env.googleClientId ? [] : ['GOOGLE_CLIENT_ID']),
      ...(env.googleClientSecret ? [] : ['GOOGLE_CLIENT_SECRET']),
    ],
  };

  return (
    <OnboardingWizard
      website={site}
      initialStep={Number.isFinite(stepParam) ? stepParam : 1}
      googleSetup={googleSetup}
      aiProviders={aiProviders}
      defaultAiProvider={defaultAiProvider}
    />
  );
}
