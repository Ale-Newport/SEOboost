import { prisma, readJson } from '@seo/db';
import { route } from '@/lib/api';
import { requireReport } from '@/app/api/_lib/reports';

/** `GET /api/reports/[id]` — one report, including its full `data` payload. */
export const GET = route<{ id: string }>(async ({ user, params }) => {
  const report = await requireReport(user, params.id);

  const website = report.websiteId
    ? await prisma.website.findUnique({
        where: { id: report.websiteId },
        select: { id: true, name: true, domain: true },
      })
    : null;

  return {
    report: {
      ...report,
      data: readJson<Record<string, unknown>>(report.data, {}),
      highlights: readJson<unknown[]>(report.highlights, []),
    },
    website,
  };
});
