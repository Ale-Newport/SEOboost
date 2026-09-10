/**
 * CSV import for backlinks — the zero-dependency path that works with **no** provider key.
 *
 * Every backlink vendor lets a user export a CSV, so this is the fallback that keeps the
 * whole backlink feature usable on a base install: parse the export, detect which columns it
 * used, validate the rows and upsert `Backlink` records.
 *
 * The parser is RFC 4180 and written here rather than pulled from npm because the rules are
 * small and the failure modes matter: a quoted anchor text containing a comma, a newline or an
 * escaped quote is completely normal in link data, and a naive `split(',')` silently corrupts
 * it. `delimiter` is configurable because Semrush's API answers with `;`-separated rows.
 */

import { prisma, Prisma } from '@seo/db';
import {
  NotFoundError,
  ValidationError,
  chunk,
  cleanDomain,
  createLogger,
  normalizeUrl,
} from '@seo/shared';
import { readDate } from '../serp/http';
import type { BacklinkRow } from './types';

const log = createLogger('backlinks:csv');

/** Row-level problems reported back to the user; enough to fix the file, not a whole log. */
const MAX_REPORTED_ERRORS = 25;
/** Guard against a paste of a multi-million-row export exhausting memory. */
export const MAX_CSV_ROWS = 500_000;

// ── RFC 4180 parser ──────────────────────────────────────────

export interface CsvParseOptions {
  /** Single-character field separator. Default `,`. */
  delimiter?: string;
  /** Trim surrounding whitespace on *unquoted* fields only. Default true. */
  trim?: boolean;
}

/**
 * Parse RFC 4180 CSV into rows of raw string fields.
 *
 * Handles: quoted fields, delimiters and CR/LF inside quotes, `""` as an escaped quote,
 * all three line terminators (`\r\n`, `\n`, `\r`), a UTF-8 BOM, and a file with or without a
 * trailing newline. Blank lines are dropped. Quoted fields are never trimmed — leading spaces
 * inside quotes are data.
 */
export function parseCsv(text: string, options: CsvParseOptions = {}): string[][] {
  const delimiter = (options.delimiter ?? ',').charAt(0) || ',';
  const trim = options.trim ?? true;
  // A BOM would otherwise become part of the first header name.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let inQuotes = false;

  const endField = (): void => {
    row.push(!quoted && trim ? field.trim() : field);
    field = '';
    quoted = false;
  };
  const endRow = (): void => {
    endField();
    // A blank line parses as one empty field; that is a separator, not a record.
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field.trim() === '') {
      // Opening quote (tolerating the leading spaces some exporters emit before it).
      field = '';
      quoted = true;
      inQuotes = true;
      continue;
    }
    if (ch === delimiter) {
      endField();
      continue;
    }
    if (ch === '\r') {
      if (src[i + 1] === '\n') i += 1;
      endRow();
      continue;
    }
    if (ch === '\n') {
      endRow();
      continue;
    }
    field += ch;
  }

  // Flush whatever the last line left behind when the file has no trailing newline.
  if (field !== '' || quoted || row.length > 0) endRow();
  return rows;
}

export interface CsvTable {
  headers: string[];
  rows: string[][];
}

/** Split a parsed CSV into its header row and the data rows. */
export function parseCsvTable(text: string, options: CsvParseOptions = {}): CsvTable {
  const parsed = parseCsv(text, options);
  if (parsed.length === 0) return { headers: [], rows: [] };
  return { headers: parsed[0], rows: parsed.slice(1) };
}

// ── Header detection ─────────────────────────────────────────

/** Fields the importer can populate from a CSV column. */
export type BacklinkCsvField =
  | 'referringDomain'
  | 'sourceUrl'
  | 'targetUrl'
  | 'anchorText'
  | 'firstSeenAt'
  | 'lastSeenAt'
  | 'dofollow'
  | 'nofollow'
  | 'linkType'
  | 'lost'
  | 'domainAuthority';

/** Lowercase and strip everything that is not a letter or digit, so `Source URL`, */
/** `source_url` and `SourceURL` collapse to the same key. */
function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Column aliases seen in Ahrefs, Semrush and Majestic exports.
 *
 * Order matters: the first field whose alias list contains a header wins, so more specific
 * names are listed on the more specific field. `referringdomains` (plural) is deliberately
 * absent — in an Ahrefs export that is a *count*, not a domain.
 */
const HEADER_ALIASES: ReadonlyArray<{ field: BacklinkCsvField; aliases: readonly string[] }> = [
  {
    field: 'sourceUrl',
    aliases: [
      'sourceurl', 'referringpageurl', 'referringpage', 'referringurl', 'urlfrom', 'fromurl',
      'pageurl', 'backlinkurl', 'linkurl', 'sourcepage', 'source',
    ],
  },
  {
    field: 'targetUrl',
    aliases: [
      'targeturl', 'urlto', 'targetpageurl', 'targetpage', 'destinationurl', 'tourl',
      'linkedpage', 'target',
    ],
  },
  {
    field: 'referringDomain',
    aliases: ['referringdomain', 'refdomain', 'sourcedomain', 'domainfrom', 'rootdomain', 'domain'],
  },
  { field: 'anchorText', aliases: ['anchortext', 'anchor', 'linkanchor'] },
  {
    field: 'firstSeenAt',
    aliases: ['firstseen', 'firstseendate', 'firstindexeddate', 'firstindexed', 'datefound', 'firstcrawled'],
  },
  {
    field: 'lastSeenAt',
    aliases: ['lastseen', 'lastseendate', 'lastcheck', 'lastcrawled', 'lastcrawldate', 'lastvisited'],
  },
  { field: 'nofollow', aliases: ['nofollow', 'isnofollow', 'flagnofollow'] },
  { field: 'dofollow', aliases: ['dofollow', 'isdofollow', 'follow', 'followed'] },
  { field: 'linkType', aliases: ['linktype', 'rel', 'relattribute', 'type'] },
  { field: 'lost', aliases: ['lost', 'loststatus', 'lostdate', 'datelost', 'islost'] },
  {
    field: 'domainAuthority',
    aliases: [
      'domainrating', 'dr', 'domainauthority', 'da', 'authorityscore', 'pageascore',
      'domainscore', 'domaintrustflow', 'sourcetrustflow', 'trustflow', 'domaininlinkrank',
    ],
  },
];

export type BacklinkCsvMapping = Partial<Record<BacklinkCsvField, number>>;

/** Map header names to column indexes. Unknown columns are simply ignored. */
export function detectBacklinkColumns(headers: readonly string[]): BacklinkCsvMapping {
  const mapping: BacklinkCsvMapping = {};
  const normalized = headers.map(normalizeHeader);
  for (const { field, aliases } of HEADER_ALIASES) {
    if (mapping[field] !== undefined) continue;
    const index = normalized.findIndex((header) => aliases.includes(header));
    if (index >= 0) mapping[field] = index;
  }
  return mapping;
}

// ── Value coercion ───────────────────────────────────────────

const TRUTHY = new Set(['true', '1', 'yes', 'y', 'dofollow', 'follow', 'followed']);
const FALSY = new Set(['false', '0', 'no', 'n', 'nofollow']);

/**
 * Three-valued on purpose: an absent column and an empty cell both mean "the export did not
 * say", which is not the same as "no". Collapsing them to `false` would mark every link in a
 * file without a follow column as nofollow.
 */
function parseFlag(value: string): boolean | null {
  const v = value.trim().toLowerCase();
  if (TRUTHY.has(v)) return true;
  if (FALSY.has(v)) return false;
  return null;
}

/** `rel`/`type` columns carry the raw attribute list; any of these three kills link equity. */
function relIsFollowed(value: string): boolean | null {
  const v = value.trim().toLowerCase();
  if (v === '') return null;
  if (/\b(nofollow|ugc|sponsored)\b/.test(v)) return false;
  if (/\b(dofollow|follow)\b/.test(v)) return true;
  return null;
}

function parseAuthority(value: string): number | null {
  const raw = value.trim().replace(',', '.');
  if (raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.min(100, Math.max(0, n)));
}

function cell(row: readonly string[], index: number | undefined): string {
  return index === undefined ? '' : (row[index] ?? '');
}

// ── Row building ─────────────────────────────────────────────

export interface BacklinkCsvParseResult {
  rows: BacklinkRow[];
  /** Header row exactly as the file spelled it. */
  headers: string[];
  /** Data rows the file contained, before validation. */
  totalRows: number;
  /** Rows dropped because a URL was missing or unusable. */
  skipped: number;
  errors: string[];
  mapping: BacklinkCsvMapping;
}

/**
 * Turn a vendor CSV into `BacklinkRow`s without touching the database — the unit-testable
 * half of the importer.
 *
 * Throws `ValidationError` (not a provider error) when the file has no recognisable source or
 * target URL column: that is a user mistake with an actionable message, not a system failure.
 */
export function parseBacklinksCsv(
  csvText: string,
  options: CsvParseOptions = {},
): BacklinkCsvParseResult {
  const { headers, rows } = parseCsvTable(csvText, options);
  if (headers.length === 0) throw new ValidationError('The CSV file is empty.');

  const mapping = detectBacklinkColumns(headers);
  if (mapping.sourceUrl === undefined || mapping.targetUrl === undefined) {
    throw new ValidationError(
      'Could not find a source URL and a target URL column. Expected headers such as ' +
        '"Referring page URL"/"source_url" and "Target URL"/"target_url".',
    );
  }
  if (rows.length > MAX_CSV_ROWS) {
    throw new ValidationError(`The CSV has more than ${MAX_CSV_ROWS} rows. Split it and import in parts.`);
  }

  const out: BacklinkRow[] = [];
  const errors: string[] = [];
  let skipped = 0;

  rows.forEach((row, index) => {
    const sourceUrl = cell(row, mapping.sourceUrl).trim();
    const targetUrl = cell(row, mapping.targetUrl).trim();
    // Line number as the user sees it: 1-based, +1 for the header row.
    const line = index + 2;

    if (!sourceUrl || !targetUrl) {
      skipped += 1;
      if (errors.length < MAX_REPORTED_ERRORS) errors.push(`Line ${line}: missing source or target URL`);
      return;
    }
    if (normalizeUrl(sourceUrl) === null || normalizeUrl(targetUrl) === null) {
      skipped += 1;
      if (errors.length < MAX_REPORTED_ERRORS) {
        errors.push(`Line ${line}: "${sourceUrl}" or "${targetUrl}" is not a usable http(s) URL`);
      }
      return;
    }

    // Precedence: an explicit dofollow flag, else an explicit nofollow flag, else the rel/type
    // column, else assume followed — which is what every exporter's blank cell means.
    const dofollow = parseFlag(cell(row, mapping.dofollow));
    const nofollow = parseFlag(cell(row, mapping.nofollow));
    const rel = relIsFollowed(cell(row, mapping.linkType));
    const isFollow = dofollow ?? (nofollow === null ? (rel ?? true) : !nofollow);

    const lastSeenAt = readDate(cell(row, mapping.lastSeenAt));
    const lostRaw = cell(row, mapping.lost).trim();
    const lostFlag = parseFlag(lostRaw);
    const lostDate = readDate(lostRaw);
    const lostAt = lostFlag === true ? (lostDate ?? lastSeenAt) : lostDate;

    const declaredDomain = cell(row, mapping.referringDomain).trim();
    out.push({
      // Prefer the URL we already validated over a declared domain column: exports sometimes
      // put a display name or a subdomain-stripped root there.
      referringDomain: cleanDomain(declaredDomain || sourceUrl),
      sourceUrl,
      targetUrl,
      anchorText: cell(row, mapping.anchorText).trim() || null,
      isFollow,
      domainAuthority: parseAuthority(cell(row, mapping.domainAuthority)),
      firstSeenAt: readDate(cell(row, mapping.firstSeenAt)),
      lastSeenAt,
      lostAt,
      provider: 'csv',
    });
  });

  return { rows: out, headers, totalRows: rows.length, skipped, errors, mapping };
}

// ── Persistence ──────────────────────────────────────────────

export const BACKLINK_STATUS_ACTIVE = 'ACTIVE';
export const BACKLINK_STATUS_LOST = 'LOST';

export interface BacklinkPersistResult {
  inserted: number;
  updated: number;
  /** Rows that already matched what we had stored. */
  unchanged: number;
}

/** Collapse duplicates on the `(sourceUrl, targetUrl)` unique key, last row winning. */
function dedupe(rows: readonly BacklinkRow[]): BacklinkRow[] {
  const byKey = new Map<string, BacklinkRow>();
  for (const row of rows) byKey.set(`${row.sourceUrl} ${row.targetUrl}`, row);
  return [...byKey.values()];
}

function earliest(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

function latest(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/**
 * Shared write path for every backlink source (CSV and the API providers).
 *
 * Existing rows are patched field-by-field rather than replaced: `firstSeenAt` only ever moves
 * earlier and `lastSeenAt` only later, so importing an older export cannot rewrite history,
 * and `isSuspicious` (owned by the analysis pass) is never touched here.
 */
export async function upsertBacklinks(
  websiteId: string,
  rows: readonly BacklinkRow[],
): Promise<BacklinkPersistResult> {
  const deduped = dedupe(rows);
  if (deduped.length === 0) return { inserted: 0, updated: 0, unchanged: 0 };
  // Without this the first `createMany` fails on the foreign key with an opaque Prisma error;
  // callers (an upload route, a queued provider import) want the typed 404 instead.
  const website = await prisma.website.findUnique({ where: { id: websiteId }, select: { id: true } });
  if (!website) throw new NotFoundError('Website');

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;

  for (const batch of chunk(deduped, 500)) {
    const existing = await prisma.backlink.findMany({
      where: { websiteId, sourceUrl: { in: batch.map((r) => r.sourceUrl) } },
      select: {
        id: true,
        sourceUrl: true,
        targetUrl: true,
        referringDomain: true,
        anchorText: true,
        isFollow: true,
        domainAuthority: true,
        firstSeenAt: true,
        lastSeenAt: true,
        lostAt: true,
        status: true,
      },
    });
    const byKey = new Map(existing.map((row) => [`${row.sourceUrl} ${row.targetUrl}`, row]));

    const creates: Prisma.BacklinkCreateManyInput[] = [];
    const updates: Array<{ id: string; data: Prisma.BacklinkUpdateInput }> = [];
    const now = new Date();

    for (const row of batch) {
      const current = byKey.get(`${row.sourceUrl} ${row.targetUrl}`);
      const status = row.lostAt ? BACKLINK_STATUS_LOST : BACKLINK_STATUS_ACTIVE;

      if (!current) {
        creates.push({
          websiteId,
          referringDomain: row.referringDomain,
          sourceUrl: row.sourceUrl,
          targetUrl: row.targetUrl,
          anchorText: row.anchorText,
          isFollow: row.isFollow,
          domainAuthority: row.domainAuthority,
          firstSeenAt: row.firstSeenAt ?? now,
          lastSeenAt: row.lastSeenAt ?? now,
          lostAt: row.lostAt,
          status,
          provider: row.provider,
        });
        continue;
      }

      const firstSeenAt = earliest(current.firstSeenAt, row.firstSeenAt);
      const lastSeenAt = latest(current.lastSeenAt, row.lastSeenAt);
      const data: Prisma.BacklinkUpdateInput = {};
      if (row.referringDomain && row.referringDomain !== current.referringDomain) {
        data.referringDomain = row.referringDomain;
      }
      if (row.anchorText !== null && row.anchorText !== current.anchorText) data.anchorText = row.anchorText;
      if (row.isFollow !== current.isFollow) data.isFollow = row.isFollow;
      if (row.domainAuthority !== null && row.domainAuthority !== current.domainAuthority) {
        data.domainAuthority = row.domainAuthority;
      }
      if (firstSeenAt && firstSeenAt.getTime() !== current.firstSeenAt.getTime()) data.firstSeenAt = firstSeenAt;
      if (lastSeenAt && lastSeenAt.getTime() !== current.lastSeenAt.getTime()) data.lastSeenAt = lastSeenAt;
      if ((row.lostAt?.getTime() ?? null) !== (current.lostAt?.getTime() ?? null)) data.lostAt = row.lostAt;
      if (status !== current.status) data.status = status;

      if (Object.keys(data).length === 0) unchanged += 1;
      else updates.push({ id: current.id, data });
    }

    if (creates.length > 0) {
      const res = await prisma.backlink.createMany({ data: creates, skipDuplicates: true });
      inserted += res.count;
    }
    // Prisma sends an interactive-batch transaction as one round trip, so chunking the updates
    // keeps a large import to a few hundred round trips instead of one per changed row.
    for (const slice of chunk(updates, 200)) {
      await prisma.$transaction(
        slice.map((u) => prisma.backlink.update({ where: { id: u.id }, data: u.data })),
      );
      updated += slice.length;
    }
  }

  return { inserted, updated, unchanged };
}

// ── Public entry point ───────────────────────────────────────

export interface ImportBacklinksCsvResult extends BacklinkPersistResult {
  /** Data rows in the file. */
  totalRows: number;
  /** Rows dropped during validation. */
  skipped: number;
  errors: string[];
  /** Detected header → field mapping, so the UI can show what it understood. */
  detectedColumns: Record<string, BacklinkCsvField>;
}

/**
 * Import a vendor backlink export for a website. Works with no provider configured — this is
 * the reason the backlink feature has no hard dependency on a paid API.
 */
export async function importBacklinksCsv(
  websiteId: string,
  csvText: string,
  options: CsvParseOptions = {},
): Promise<ImportBacklinksCsvResult> {
  const parsed = parseBacklinksCsv(csvText, options);
  const persisted = await upsertBacklinks(websiteId, parsed.rows);

  const detectedColumns: Record<string, BacklinkCsvField> = {};
  for (const { field } of HEADER_ALIASES) {
    const index = parsed.mapping[field];
    if (index === undefined) continue;
    const header = parsed.headers[index];
    if (header) detectedColumns[header] = field;
  }

  log.info('backlink csv imported', {
    websiteId,
    totalRows: parsed.totalRows,
    inserted: persisted.inserted,
    updated: persisted.updated,
    skipped: parsed.skipped,
  });

  return {
    ...persisted,
    totalRows: parsed.totalRows,
    skipped: parsed.skipped,
    errors: parsed.errors,
    detectedColumns,
  };
}
