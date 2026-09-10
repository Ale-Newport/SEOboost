/**
 * RFC 4180 CSV serialisation plus browser downloads.
 *
 * Written by hand rather than pulled from a dependency because the export path has three
 * requirements a naive `rows.map(r => r.join(','))` gets wrong: quoting rules, Excel's encoding
 * sniffing, and spreadsheet formula injection.
 */

export type CsvCell = string | number | boolean | Date | null | undefined;

export type CsvRow = Record<string, CsvCell>;

export interface CsvOptions {
  /** Field delimiter. RFC 4180 says comma; `;` and `\t` are the common alternatives. */
  delimiter?: string;
  /**
   * Prepend a UTF-8 BOM. Excel assumes the OS legacy code page for BOM-less files, which
   * mangles every non-ASCII character in a URL or a non-English keyword. Default on.
   */
  bom?: boolean;
  /** Explicit column order. Defaults to the union of the row keys, in first-seen order. */
  columns?: readonly string[];
  /** Header text per column id. Defaults to the column id itself. */
  headers?: Readonly<Record<string, string>>;
  /**
   * Neutralise values a spreadsheet would evaluate as a formula (CSV injection: a cell such as
   * `=HYPERLINK(...)` or `+cmd|...` runs on open). Prefixing with an apostrophe keeps the text
   * visible while forcing it to be literal. Default on — exports are shared over email.
   */
  sanitizeFormulas?: boolean;
}

const DEFAULT_DELIMITER = ',';
/** RFC 4180 mandates CRLF between records. */
const EOL = '\r\n';
const BOM = '\uFEFF';

/** Leading characters a spreadsheet treats as the start of a formula. */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/**
 * `JSON.stringify` that cannot throw: BigInt and circular references are the two things a row of
 * database-derived values realistically contains that the plain call rejects, and an export must
 * not silently produce nothing because one cell held one of them.
 */
export function safeJsonStringify(value: unknown, space?: number): string {
  const seen = new WeakSet<object>();
  const json = JSON.stringify(
    value,
    (_key, entry: unknown) => {
      if (typeof entry === 'bigint') return entry.toString();
      if (typeof entry === 'object' && entry !== null) {
        if (seen.has(entry)) return '[Circular]';
        seen.add(entry);
      }
      return entry;
    },
    space,
  );
  // `JSON.stringify(undefined)` and functions return undefined rather than a string.
  return json ?? 'null';
}

/**
 * Widen an arbitrary accessor result into something a CSV cell can hold.
 * Objects become JSON rather than `[object Object]`, arrays become a readable list.
 */
export function coerceCsvCell(value: unknown): CsvCell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((entry) => String(coerceCsvCell(entry) ?? '')).join(', ');
  return safeJsonStringify(value);
}

/** Render one cell as plain text, before quoting. */
export function formatCsvCell(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return value;
}

/**
 * Quote a field when RFC 4180 requires it: it contains the delimiter, a double quote, or a line
 * break. Embedded quotes are escaped by doubling. Fields with surrounding whitespace are quoted
 * too, since several parsers trim unquoted fields.
 */
export function escapeCsvField(
  value: CsvCell,
  delimiter: string = DEFAULT_DELIMITER,
  sanitizeFormulas = true,
): string {
  let text = formatCsvCell(value);
  if (sanitizeFormulas && FORMULA_PREFIX.test(text)) text = `'${text}`;

  const needsQuotes =
    text.includes(delimiter) ||
    text.includes('"') ||
    text.includes('\n') ||
    text.includes('\r') ||
    text !== text.trim();

  return needsQuotes ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Column ids in first-seen order across every row — stable even when rows are sparse. */
function inferColumns(rows: ReadonlyArray<CsvRow>): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) seen.add(key);
  }
  return [...seen];
}

/**
 * Serialise rows to an RFC 4180 document. No trailing newline: a final CRLF makes some parsers
 * report a phantom empty record, and the spec makes it optional.
 */
export function toCsv(rows: ReadonlyArray<CsvRow>, options: CsvOptions = {}): string {
  const {
    delimiter = DEFAULT_DELIMITER,
    bom = true,
    columns = inferColumns(rows),
    headers = {},
    sanitizeFormulas = true,
  } = options;

  const lines: string[] = [
    columns.map((id) => escapeCsvField(headers[id] ?? id, delimiter, sanitizeFormulas)).join(delimiter),
  ];

  for (const row of rows) {
    lines.push(columns.map((id) => escapeCsvField(row[id], delimiter, sanitizeFormulas)).join(delimiter));
  }

  return `${bom ? BOM : ''}${lines.join(EOL)}`;
}

/** `Top pages` → `top-pages`. Keeps download filenames safe on every OS. */
export function slugifyFilename(input: string): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'export';
}

/** `traffic` → `traffic-2026-09-09`. Local calendar date, because that is what the user sees. */
export function timestampedFilename(base: string, date = new Date()): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${slugifyFilename(base)}-${yyyy}-${mm}-${dd}`;
}

function withExtension(filename: string, extension: string): string {
  return filename.toLowerCase().endsWith(extension) ? filename : `${filename}${extension}`;
}

/**
 * Hand a generated file to the browser.
 *
 * No-ops outside the browser rather than throwing: these functions live in modules that are
 * imported (though never called) during server rendering.
 */
export function downloadBlob(filename: string, content: BlobPart, mimeType: string): void {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return;

  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Safari needs the URL to outlive the synchronous click handler.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadCsv(filename: string, rows: ReadonlyArray<CsvRow>, options: CsvOptions = {}): void {
  downloadBlob(withExtension(filename, '.csv'), toCsv(rows, options), 'text/csv;charset=utf-8');
}

export function downloadJson(filename: string, data: unknown): void {
  // `safeJsonStringify` rather than a try/catch that returns: a click on "Export JSON" that
  // produces no file and no error is indistinguishable from a broken button.
  downloadBlob(withExtension(filename, '.json'), safeJsonStringify(data, 2), 'application/json;charset=utf-8');
}
