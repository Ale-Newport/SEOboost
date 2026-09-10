import { NextResponse } from 'next/server';
import { z } from 'zod';
import { readJson } from '@seo/db';
import { formatDateKey, slugify } from '@seo/shared';
import { csvResponse, readQuery, route } from '@/lib/api';
import { reportToCsvRows, requireReport } from '@/app/api/_lib/reports';

/**
 * `GET /api/reports/[id]/export?format=csv|json` — download a report.
 *
 * CSV flattens whichever part of the payload is actually tabular; JSON is the stored payload
 * verbatim so nothing is lost for callers that can read it.
 */

const querySchema = z.object({
  format: z.enum(['csv', 'json']).default('csv'),
});

export const GET = route<{ id: string }>(async ({ user, request, params }) => {
  const query = readQuery(request, querySchema);
  const report = await requireReport(user, params.id);

  const filenameBase = `${slugify(report.title || report.type)}-${formatDateKey(report.periodEnd)}`;

  if (query.format === 'json') {
    const body = JSON.stringify(
      {
        id: report.id,
        websiteId: report.websiteId,
        type: report.type,
        title: report.title,
        periodStart: report.periodStart,
        periodEnd: report.periodEnd,
        summary: report.summary,
        highlights: readJson<unknown[]>(report.highlights, []),
        data: readJson<Record<string, unknown>>(report.data, {}),
        createdAt: report.createdAt,
      },
      null,
      2,
    );
    return new NextResponse(body, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filenameBase}.json"`,
      },
    });
  }

  const { rows } = reportToCsvRows(report);
  return csvResponse(`${filenameBase}.csv`, rows);
});
