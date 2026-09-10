import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { PageHeader } from '@/components/ui/page-header';
import { AddWebsiteForm } from '@/components/site/add-website-form';

export const metadata: Metadata = { title: 'Add website' };
export const dynamic = 'force-dynamic';

export default async function NewSitePage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 md:px-6">
      <PageHeader
        title="Add a website"
        description="The more context you give here, the better the content and GEO agents perform. Everything except the domain can be filled in later."
      />
      <AddWebsiteForm />
    </div>
  );
}
