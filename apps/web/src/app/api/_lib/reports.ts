import 'server-only';
import { type Report, prisma, readJson } from '@seo/db';
import { ForbiddenError, NotFoundError } from '@seo/shared';
import type { SessionUser } from '@/lib/auth';

/**
 * Report access and CSV flattening.
 *
 * A report's `data` column is whatever the generator wrote — its shape varies by report type —
 * so the CSV export never guesses at a schema. It looks for a real table in the payload, falls
 * back to the highlights, and finally to the report header. It never fabricates rows to make
 * a file look populated: an empty report exports an empty file.
 */

export async function requireReport(user: SessionUser, reportId: string): Promise<Report> {
  const report = await prisma.report.findUnique({ where: { id: reportId } });
  if (!report) throw new NotFoundError('Report');

  if (report.websiteId) {
    const website = await prisma.website.findUnique({
      where: { id: report.websiteId },
      select: { userId: true },
    });
    if (!website) throw new NotFoundError('Report');
    if (website.userId !== user.id) throw new ForbiddenError('You do not have access to this report.');
  }
  return report;
}

type Row = Record<string, unknown>;

function isRowArray(value: unknown): value is Row[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === 'object' && entry !== null && !Array.isArray(entry))
  );
}

/** Flatten one level of nesting so `{ metrics: { clicks: 1 } }` exports as `metrics.clicks`. */
function flattenRow(row: Row, prefix = ''): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(out, flattenRow(value as Row, path));
    } else if (Array.isArray(value)) {
      out[path] = value.map((entry) => (typeof entry === 'object' ? JSON.stringify(entry) : entry)).join('; ');
    } else {
      out[path] = value;
    }
  }
  return out;
}

export interface ReportCsv {
  rows: Row[];
  /** Where the rows came from, so the UI can say what the file contains. */
  source: 'data.rows' | 'data.table' | 'highlights' | 'summary' | 'empty';
}

/** Pick the most table-shaped thing in the report and flatten it for CSV. */
export function reportToCsvRows(report: Report): ReportCsv {
  const data = readJson<Record<string, unknown>>(report.data, {});

  if (isRowArray(data.rows)) {
    return { rows: data.rows.map((row) => flattenRow(row)), source: 'data.rows' };
  }

  // Any other top-level array of objects is the report's table by elimination.
  for (const [key, value] of Object.entries(data)) {
    if (isRowArray(value)) {
      return { rows: value.map((row) => flattenRow({ section: key, ...row })), source: 'data.table' };
    }
  }

  const highlights = readJson<unknown[]>(report.highlights, []);
  if (Array.isArray(highlights) && highlights.length > 0) {
    return {
      rows: highlights.map((entry, index) =>
        typeof entry === 'object' && entry !== null
          ? flattenRow(entry as Row)
          : { index: index + 1, highlight: String(entry) },
      ),
      source: 'highlights',
    };
  }

  if (report.summary) {
    return {
      rows: [
        {
          id: report.id,
          type: report.type,
          title: report.title,
          periodStart: report.periodStart,
          periodEnd: report.periodEnd,
          summary: report.summary,
        },
      ],
      source: 'summary',
    };
  }

  return { rows: [], source: 'empty' };
}
