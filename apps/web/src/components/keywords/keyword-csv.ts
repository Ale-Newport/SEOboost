/**
 * Client-side CSV parsing for the keyword importer.
 *
 * Deliberately mirrors `/api/websites/[id]/keywords/import` rather than posting raw text to it:
 * the screen has to show a preview and per-row validation errors *before* anything is written,
 * and the only way that preview can be trustworthy is if the browser does exactly the parse the
 * server would. Because the valid rows are then posted as JSON, the preview is not an
 * approximation of the import — it is the import.
 *
 * `normalizeKeyword` is copied from `@seo/shared/text` for the same reason the content editor
 * copies its word count: that module opens with `import { createHash } from 'node:crypto'` and
 * cannot be pulled into a browser bundle. The definition below matches it character for
 * character, so the duplicates this file reports are the duplicates the server would collapse.
 */

export const KEYWORD_IMPORT_MAX_ROWS = 10_000;
export const KEYWORD_IMPORT_MAX_BYTES = 5_000_000;

export type ImportIntent =
  | 'INFORMATIONAL'
  | 'NAVIGATIONAL'
  | 'COMMERCIAL'
  | 'TRANSACTIONAL'
  | 'LOCAL'
  | 'UNKNOWN';

const INTENT_VALUES: readonly ImportIntent[] = [
  'INFORMATIONAL',
  'NAVIGATIONAL',
  'COMMERCIAL',
  'TRANSACTIONAL',
  'LOCAL',
  'UNKNOWN',
];

export interface ImportRow {
  keyword: string;
  searchVolume?: number;
  difficulty?: number;
  cpc?: number;
  locale?: string;
  intent?: ImportIntent;
}

export interface ImportIssue {
  /** 1-based line in the pasted text, so "row 41" means what the user sees in their editor. */
  line: number;
  value: string;
  message: string;
}

export interface ParsedImport {
  /** Rows that will actually be sent. */
  rows: ImportRow[];
  issues: ImportIssue[];
  /** Rows dropped because an earlier row in the same file already claimed the keyword. */
  duplicates: number;
  /** True when a recognised header row was found; otherwise the file is read as one keyword per line. */
  hasHeader: boolean;
  /** Columns that were recognised, in file order — shown so a mis-mapped export is obvious. */
  mappedColumns: string[];
  /** Column headers present in the file that mean nothing to the importer. */
  ignoredColumns: string[];
  /** Rows found before the row cap was applied. */
  totalRows: number;
  truncated: boolean;
}

/** Matches `normalizeKeyword` in `@seo/shared/text`. See the file header for why it is copied. */
export function normalizeKeyword(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** RFC-4180 field splitter: quoted commas, escaped quotes, CRLF, plus tab and semicolon delimiters. */
function parseCsv(text: string): Array<{ line: number; cells: string[] }> {
  const rows: Array<{ line: number; cells: string[] }> = [];
  let cells: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let rowStartLine = 1;

  const pushRow = (): void => {
    cells.push(field);
    if (cells.some((cell) => cell.trim().length > 0)) rows.push({ line: rowStartLine, cells });
    cells = [];
    field = '';
    rowStartLine = line;
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (char === '\n') line++;
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',' || char === '\t' || char === ';') {
      cells.push(field);
      field = '';
    } else if (char === '\n') {
      line++;
      pushRow();
    } else if (char !== '\r') {
      field += char;
    }
  }

  if (field.length > 0 || cells.length > 0) pushRow();
  return rows;
}

/** Column aliases across the exports people actually paste in (GSC, Ahrefs, Semrush, Moz). */
const COLUMN_ALIASES: Record<keyof ImportRow, readonly string[]> = {
  keyword: ['keyword', 'keywords', 'query', 'term', 'search term', 'top queries'],
  searchVolume: [
    'searchvolume',
    'search volume',
    'volume',
    'monthly searches',
    'avg. monthly searches',
    'vol.',
    'vol',
  ],
  difficulty: ['difficulty', 'kd', 'keyword difficulty', 'competition index'],
  cpc: ['cpc', 'cost per click', 'cpc (usd)'],
  locale: ['locale', 'language', 'lang'],
  intent: ['intent', 'search intent'],
};

const COLUMN_LABELS: Record<keyof ImportRow, string> = {
  keyword: 'Keyword',
  searchVolume: 'Search volume',
  difficulty: 'Difficulty',
  cpc: 'CPC',
  locale: 'Locale',
  intent: 'Intent',
};

function matchColumn(header: string): keyof ImportRow | null {
  const normalized = header.trim().toLowerCase();
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    if (aliases.includes(normalized)) return field as keyof ImportRow;
  }
  return null;
}

/** `1,234`, `$1.20`, `45%` → a number. Undefined for anything that is not numeric. */
function parseNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const cleaned = raw.replace(/[^0-9.\-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return undefined;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Parse pasted or uploaded text into the rows the import endpoint accepts.
 *
 * A file with no recognisable header is read as a plain one-keyword-per-line list — that is how
 * most people paste a keyword list — but a header row that *is* recognised is never read as data.
 */
export function parseKeywordImport(text: string): ParsedImport {
  const table = parseCsv(text);
  const empty: ParsedImport = {
    rows: [],
    issues: [],
    duplicates: 0,
    hasHeader: false,
    mappedColumns: [],
    ignoredColumns: [],
    totalRows: 0,
    truncated: false,
  };
  if (table.length === 0) return empty;

  const headerCells = table[0]?.cells ?? [];
  const mapping = headerCells.map(matchColumn);
  const hasHeader = mapping.some((column) => column === 'keyword');

  const dataRows = hasHeader ? table.slice(1) : table;
  const mappedColumns = hasHeader
    ? mapping.filter((column): column is keyof ImportRow => column !== null).map((column) => COLUMN_LABELS[column])
    : ['Keyword'];
  const ignoredColumns = hasHeader
    ? headerCells.filter((header, index) => mapping[index] === null && header.trim().length > 0).map((h) => h.trim())
    : [];

  const issues: ImportIssue[] = [];
  const seen = new Set<string>();
  const rows: ImportRow[] = [];
  let duplicates = 0;

  for (const { line, cells } of dataRows) {
    if (rows.length >= KEYWORD_IMPORT_MAX_ROWS) break;

    const record: ImportRow = { keyword: '' };

    if (hasHeader) {
      mapping.forEach((column, index) => {
        if (column === null) return;
        const raw = cells[index]?.trim();
        if (!raw) return;

        switch (column) {
          case 'keyword':
            record.keyword = raw;
            break;
          case 'searchVolume': {
            const value = parseNumber(raw);
            if (value === undefined) issues.push({ line, value: raw, message: 'Search volume is not a number.' });
            else if (value < 0) issues.push({ line, value: raw, message: 'Search volume cannot be negative.' });
            else record.searchVolume = Math.round(value);
            break;
          }
          case 'difficulty': {
            const value = parseNumber(raw);
            if (value === undefined) issues.push({ line, value: raw, message: 'Difficulty is not a number.' });
            else if (value < 0 || value > 100)
              issues.push({ line, value: raw, message: 'Difficulty must be between 0 and 100.' });
            else record.difficulty = value;
            break;
          }
          case 'cpc': {
            const value = parseNumber(raw);
            if (value === undefined) issues.push({ line, value: raw, message: 'CPC is not a number.' });
            else if (value < 0) issues.push({ line, value: raw, message: 'CPC cannot be negative.' });
            else record.cpc = value;
            break;
          }
          case 'locale':
            if (raw.length > 10) issues.push({ line, value: raw, message: 'Locale must be 10 characters or fewer.' });
            else record.locale = raw;
            break;
          case 'intent': {
            const upper = raw.toUpperCase();
            if ((INTENT_VALUES as readonly string[]).includes(upper)) record.intent = upper as ImportIntent;
            else
              issues.push({
                line,
                value: raw,
                message: `Unknown intent. Use one of ${INTENT_VALUES.join(', ')}.`,
              });
            break;
          }
        }
      });
    } else {
      record.keyword = cells[0]?.trim() ?? '';
    }

    const keyword = record.keyword.trim();
    if (keyword.length === 0) {
      issues.push({ line, value: cells.join(', ').slice(0, 60), message: 'No keyword in this row.' });
      continue;
    }
    if (keyword.length > 300) {
      issues.push({ line, value: keyword.slice(0, 60), message: 'Keyword is longer than 300 characters.' });
      continue;
    }

    const key = `${normalizeKeyword(keyword)}::${record.locale ?? ''}`;
    if (key === '::' || normalizeKeyword(keyword).length === 0) {
      issues.push({ line, value: keyword, message: 'Nothing is left of this keyword once punctuation is stripped.' });
      continue;
    }
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);

    rows.push({ ...record, keyword });
  }

  return {
    rows,
    issues,
    duplicates,
    hasHeader,
    mappedColumns,
    ignoredColumns,
    totalRows: dataRows.length,
    truncated: dataRows.length > KEYWORD_IMPORT_MAX_ROWS,
  };
}
