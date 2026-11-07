import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';

import { getCurrentUser } from '@/lib/auth';
import { getSocialOverview } from '@/server/queries/social';
import { SocialView } from '@/components/social/social-view';
import {
  CONVERSATION_FILTERS,
  SOCIAL_TABS,
  type ConversationFilter,
  type SocialTab,
} from '@/components/social/types';

export const metadata: Metadata = { title: 'Social' };
export const dynamic = 'force-dynamic';

type RawSearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

function readTab(raw: string | string[] | undefined): SocialTab {
  const value = first(raw);
  return SOCIAL_TABS.find((tab) => tab === value) ?? 'inbox';
}

function readFilter(raw: string | string[] | undefined): ConversationFilter {
  const value = first(raw);
  return CONVERSATION_FILTERS.find((filter) => filter === value) ?? 'open';
}

export default async function SocialPage({
  params,
  searchParams,
}: {
  params: Promise<{ websiteId: string }>;
  searchParams: Promise<RawSearchParams>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const { websiteId } = await params;
  const query = await searchParams;

  let data;
  try {
    data = await getSocialOverview(user.id, websiteId, { conversationFilter: readFilter(query.filter) });
  } catch {
    notFound();
  }
  return <SocialView data={data} initialTab={readTab(query.tab)} />;
}
