import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { getCurrentUser } from '@/lib/auth';
import { getMailOverview } from '@/server/queries/mail';
import { MailView } from '@/components/mail/mail-view';

export const metadata: Metadata = { title: 'Mail' };
export const dynamic = 'force-dynamic';

export default async function MailPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  return <MailView initial={await getMailOverview(user.id)} />;
}
