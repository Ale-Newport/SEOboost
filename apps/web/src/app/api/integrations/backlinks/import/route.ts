import { z } from 'zod';
import { ValidationError, createLogger } from '@seo/shared';
import { MAX_CSV_ROWS, importBacklinksCsv } from '@seo/integrations/backlinks/csv';
import { requireWebsite, route } from '@/lib/api';
import { assertNotReadOnly } from '@/app/api/_lib/common';

const log = createLogger('api:integrations:backlinks');

/**
 * `POST /api/integrations/backlinks/import` — ingest a vendor backlink export.
 *
 * This is why the backlink feature has no hard dependency on a paid API: every analysis in the
 * product runs off stored rows, and those rows can come from a CSV. Accepts either a
 * `multipart/form-data` upload (the browser path) or a JSON body carrying the CSV text (the
 * scripted path); the column mapping is detected and reported back so the operator can see
 * exactly what was understood.
 */

/** Hard ceiling on the uploaded payload, well above a normal vendor export. */
const MAX_CSV_BYTES = 25 * 1024 * 1024;

const jsonSchema = z.object({
  websiteId: z.string().trim().min(1),
  csv: z.string().min(1),
});

interface Upload {
  websiteId: string;
  csv: string;
  filename: string | null;
}

async function readUpload(request: Request): Promise<Upload> {
  const contentType = request.headers.get('content-type') ?? '';

  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData();
    const websiteId = form.get('websiteId');
    const file = form.get('file');

    if (typeof websiteId !== 'string' || !websiteId.trim()) {
      throw new ValidationError('websiteId is required.');
    }
    if (typeof file === 'string') {
      return { websiteId: websiteId.trim(), csv: file, filename: null };
    }
    if (!file || typeof file.size !== 'number') {
      throw new ValidationError('Attach the export as the "file" field.');
    }
    if (file.size > MAX_CSV_BYTES) {
      throw new ValidationError(`That file is larger than the ${MAX_CSV_BYTES / 1024 / 1024} MB limit.`);
    }
    return {
      websiteId: websiteId.trim(),
      csv: await file.text(),
      filename: 'name' in file && typeof file.name === 'string' ? file.name : null,
    };
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new ValidationError(
      'Send the export as multipart/form-data (fields: websiteId, file) or as JSON { websiteId, csv }.',
    );
  }
  const parsed = jsonSchema.parse(raw);
  if (parsed.csv.length > MAX_CSV_BYTES) {
    throw new ValidationError(`That payload is larger than the ${MAX_CSV_BYTES / 1024 / 1024} MB limit.`);
  }
  return { websiteId: parsed.websiteId, csv: parsed.csv, filename: null };
}

export const POST = route(async ({ user, request }) => {
  const upload = await readUpload(request);
  await assertNotReadOnly();
  const website = await requireWebsite(user.id, upload.websiteId);

  const result = await importBacklinksCsv(website.id, upload.csv);

  log.info('backlink csv imported', {
    websiteId: website.id,
    filename: upload.filename,
    totalRows: result.totalRows,
    inserted: result.inserted,
    updated: result.updated,
    skipped: result.skipped,
  });

  return {
    websiteId: website.id,
    filename: upload.filename,
    ...result,
    maxRows: MAX_CSV_ROWS,
  };
});
