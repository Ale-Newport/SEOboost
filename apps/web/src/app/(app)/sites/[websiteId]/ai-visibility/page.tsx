import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';

import { getCurrentUser } from '@/lib/auth';
import { getAiVisibility } from '@/server/queries/ai-visibility';
import { AiVisibilityView } from '@/components/ai-visibility/ai-visibility-view';

export const metadata: Metadata = { title: 'AI visibility' };
export const dynamic = 'force-dynamic';

/** Default aggregation window. Long enough that a weekly prompt run produces a readable trend. */
const DEFAULT_DAYS = 90;

type RawSearchParams = Record<string, string | string[] | undefined>;

/** `?days=` bounds the aggregation window; anything unparseable falls back to the default. */
function readDays(raw: string | string[] | undefined): number {
  const value = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isFinite(value)) return DEFAULT_DAYS;
  return Math.min(365, Math.max(1, Math.floor(value)));
}

export default async function AiVisibilityPage({
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

  try {
    const data = await getAiVisibility(user.id, websiteId, readDays(query.days));
    return <AiVisibilityView data={data} />;
  } catch {
    notFound();
  }
}
