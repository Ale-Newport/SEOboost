import { z } from 'zod';
import { type Prisma, type SearchIntent, createManyChunked, prisma } from '@seo/db';
import {
  ValidationError,
  chunk,
  createLogger,
  keywordImportSchema,
  normalizeKeyword,
} from '@seo/shared';
import { readBody, requireWebsite, route } from '@/lib/api';

const log = createLogger('api:keyword-import');

type Params = { id: string };

type KeywordRowInput = z.infer<typeof keywordImportSchema>['keywords'][number];

const bodySchema = z
  .object({
    keywords: keywordImportSchema.shape.keywords.optional(),
    /** Raw CSV text, as pasted or read from an uploaded file by the client. */
    csv: z.string().max(20_000_000).optional(),
    /** Omitted, the provenance is inferred from how the rows arrived — never guessed later. */
    source: keywordImportSchema.shape.source.optional(),
    /** Applied to rows that do not carry their own locale. Defaults to the site's first locale. */
    locale: z.string().trim().min(2).max(10).optional(),
  })
  .refine((body) => Boolean(body.keywords) !== Boolean(body.csv?.trim()), {
    message: 'Send either `keywords` rows or `csv` text — not both, and not neither.',
  });

// ── CSV parsing ──────────────────────────────────────────────

/** RFC-4180 field splitter: handles quoted commas, escaped quotes and CRLF line endings. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  // Excel — and this app's own CSV exports — prefix the file with a UTF-8 BOM. Left in place it
  // becomes part of the first header cell, so "keyword" stops matching, the file is misread as
  // headerless, and every volume/difficulty column is silently dropped.
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < source.length; i++) {
    const char = source[i];

    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',' || char === '\t' || char === ';') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((entry) => entry.some((cell) => cell.trim().length > 0));
}

/** Column aliases across the exports people actually paste in (GSC, Ahrefs, Semrush, Moz). */
const COLUMN_ALIASES: Record<keyof Omit<KeywordRowInput, 'keyword'> | 'keyword', string[]> = {
  keyword: ['keyword', 'keywords', 'query', 'term', 'search term', 'top queries'],
  searchVolume: ['searchvolume', 'search volume', 'volume', 'monthly searches', 'avg. monthly searches', 'vol.', 'vol'],
  difficulty: ['difficulty', 'kd', 'keyword difficulty', 'competition index'],
  cpc: ['cpc', 'cost per click', 'cpc (usd)'],
  locale: ['locale', 'language', 'lang'],
  intent: ['intent', 'search intent'],
};

function matchColumn(header: string): keyof KeywordRowInput | null {
  const normalized = header.trim().toLowerCase();
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    if (aliases.includes(normalized)) return field as keyof KeywordRowInput;
  }
  return null;
}

/** `1,234`, `$1.20`, `45%` → a number. Returns undefined for anything that is not numeric. */
function parseNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const cleaned = raw.replace(/[^0-9.\-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return undefined;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : undefined;
}

const INTENT_VALUES = new Set([
  'INFORMATIONAL',
  'NAVIGATIONAL',
  'COMMERCIAL',
  'TRANSACTIONAL',
  'LOCAL',
  'UNKNOWN',
]);

/**
 * Turn CSV text into keyword rows.
 *
 * A file with no recognisable header is treated as a plain one-keyword-per-line list rather
 * than being rejected — that is how most people paste a keyword list — but a header row that
 * *is* recognised is never treated as data.
 */
function rowsFromCsv(text: string): unknown[] {
  const table = parseCsv(text);
  if (table.length === 0) return [];

  const headerRow = table[0] ?? [];
  const mapping = headerRow.map(matchColumn);
  const hasHeader = mapping.some((column) => column === 'keyword');

  if (!hasHeader) {
    return table
      .map((row) => row[0]?.trim())
      .filter((value): value is string => Boolean(value))
      .map((keyword) => ({ keyword }));
  }

  const dataRows = table.slice(1);
  const rows: unknown[] = [];

  for (const cells of dataRows) {
    const record: Record<string, unknown> = {};
    mapping.forEach((column, index) => {
      if (!column) return;
      const raw = cells[index]?.trim();
      if (!raw) return;

      switch (column) {
        case 'keyword':
          record.keyword = raw;
          break;
        case 'searchVolume': {
          const value = parseNumber(raw);
          if (value !== undefined) record.searchVolume = Math.round(value);
          break;
        }
        case 'difficulty': {
          const value = parseNumber(raw);
          if (value !== undefined) record.difficulty = value;
          break;
        }
        case 'cpc': {
          const value = parseNumber(raw);
          if (value !== undefined) record.cpc = value;
          break;
        }
        case 'locale':
          record.locale = raw;
          break;
        case 'intent': {
          const upper = raw.toUpperCase();
          if (INTENT_VALUES.has(upper)) record.intent = upper;
          break;
        }
      }
    });

    if (typeof record.keyword === 'string' && record.keyword.length > 0) rows.push(record);
  }

  return rows;
}

// ── Import ───────────────────────────────────────────────────

interface PreparedRow {
  key: string;
  normalized: string;
  locale: string;
  keyword: string;
  searchVolume: number | null;
  difficulty: number | null;
  cpc: number | null;
  intent: SearchIntent | null;
}

/**
 * Import keywords from CSV text or JSON rows.
 *
 * Existing keywords are updated rather than duplicated — `(websiteId, normalized, locale)` is
 * the natural key — and an update only writes the metric columns the file actually carried, so
 * re-importing a keyword-only list cannot wipe volumes that a provider previously supplied.
 * Nothing is estimated: a row without a volume produces a keyword with a null volume.
 */
export const POST = route<Params>(async ({ user, request, params }) => {
  const website = await requireWebsite(user.id, params.id);
  const body = await readBody(request, bodySchema);

  const rawRows = body.csv ? rowsFromCsv(body.csv) : body.keywords;
  if (!rawRows || rawRows.length === 0) {
    throw new ValidationError('No keyword rows were found in the import.');
  }
  if (rawRows.length > 10_000) {
    throw new ValidationError(
      `This import has ${rawRows.length.toLocaleString()} rows; split it into files of 10,000 or fewer.`,
    );
  }

  // Reuse the shared row schema so CSV and JSON imports are validated identically.
  const rows = keywordImportSchema.shape.keywords.parse(rawRows);

  const source = body.source ?? (body.csv ? 'CSV_IMPORT' : 'MANUAL');
  const defaultLocale = body.locale ?? website.targetLocales[0] ?? 'en-US';

  // Deduplicate within the file: a later row wins, which is what a re-export with corrections
  // means. Doing it here also keeps `createMany` from tripping the unique index on itself.
  const prepared = new Map<string, PreparedRow>();
  let invalid = 0;
  for (const row of rows) {
    const normalized = normalizeKeyword(row.keyword);
    if (!normalized) {
      invalid += 1;
      continue;
    }
    const locale = row.locale ?? defaultLocale;
    prepared.set(`${normalized}::${locale}`, {
      key: `${normalized}::${locale}`,
      normalized,
      locale,
      keyword: row.keyword,
      searchVolume: row.searchVolume ?? null,
      difficulty: row.difficulty ?? null,
      cpc: row.cpc ?? null,
      intent: row.intent ?? null,
    });
  }

  const entries = [...prepared.values()];
  const duplicatesInFile = rows.length - entries.length - invalid;

  // Chunked lookup: a single `in` with 10k values would blow past sensible parameter limits.
  const existing = new Map<string, { id: string }>();
  for (const slice of chunk(entries, 1000)) {
    const found = await prisma.keyword.findMany({
      where: {
        websiteId: website.id,
        normalized: { in: slice.map((entry) => entry.normalized) },
      },
      select: { id: true, normalized: true, locale: true },
    });
    for (const row of found) existing.set(`${row.normalized}::${row.locale}`, { id: row.id });
  }

  const toCreate = entries.filter((entry) => !existing.has(entry.key));
  const toUpdate = entries.filter((entry) => existing.has(entry.key));
  const now = new Date();
  const language = defaultLocale.split('-')[0] ?? 'en';

  const created = await createManyChunked<Prisma.KeywordCreateManyInput>(
    prisma.keyword,
    toCreate.map((entry) => ({
      websiteId: website.id,
      keyword: entry.keyword,
      normalized: entry.normalized,
      locale: entry.locale,
      language: entry.locale.split('-')[0] ?? language,
      country: website.targetCountry,
      source,
      ...(entry.searchVolume === null ? {} : { searchVolume: entry.searchVolume }),
      ...(entry.difficulty === null ? {} : { difficulty: entry.difficulty }),
      ...(entry.cpc === null ? {} : { cpc: entry.cpc }),
      ...(entry.intent === null ? {} : { intent: entry.intent }),
      // Volumes that came from a file are attributed to the file, not to a provider we never called.
      ...(entry.searchVolume === null ? {} : { volumeSource: source }),
      firstSeenAt: now,
      lastSeenAt: now,
    })),
  );

  // Only the columns the file supplied are written; a null in the import means "not stated",
  // never "set this back to unknown".
  let updated = 0;
  for (const slice of chunk(toUpdate, 100)) {
    const writes = slice
      .map((entry) => {
        const data: Prisma.KeywordUpdateInput = { lastSeenAt: now };
        if (entry.searchVolume !== null) {
          data.searchVolume = entry.searchVolume;
          data.volumeSource = source;
        }
        if (entry.difficulty !== null) data.difficulty = entry.difficulty;
        if (entry.cpc !== null) data.cpc = entry.cpc;
        if (entry.intent !== null) data.intent = entry.intent;

        const id = existing.get(entry.key)?.id;
        if (!id) return null;
        return prisma.keyword.update({ where: { id }, data });
      })
      .filter((write): write is NonNullable<typeof write> => write !== null);

    if (writes.length > 0) {
      await prisma.$transaction(writes);
      updated += writes.length;
    }
  }

  log.info('keywords imported', {
    websiteId: website.id,
    received: rows.length,
    created,
    updated,
    source,
  });

  return {
    received: rows.length,
    created,
    updated,
    duplicatesInFile: Math.max(0, duplicatesInFile),
    invalid,
    source,
    locale: defaultLocale,
  };
});
