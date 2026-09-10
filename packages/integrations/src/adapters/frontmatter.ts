/**
 * Minimal YAML frontmatter parser + serialiser.
 *
 * Written by hand rather than pulling in `gray-matter`/`js-yaml` because the git
 * adapter rewrites files in a customer's repository: the round-trip has to be
 * predictable and auditable, and we only ever need the subset of YAML that
 * actually shows up in Markdown/MDX frontmatter.
 *
 * Supported on read: block mappings, block sequences (`- x` and `- key: v`),
 * flow sequences/mappings (`[a, b]`, `{a: 1}`), single/double quoted scalars,
 * literal (`|`) and folded (`>`) block scalars with `-`/`+` chomping, comments,
 * numbers, booleans, `null`/`~`.
 *
 * Deliberately NOT supported: anchors/aliases, tags, multi-document streams,
 * explicit keys. Files using those are returned with `hasFrontmatter: true` and
 * whatever we could parse — the adapter refuses to rewrite a file whose
 * frontmatter did not round-trip, so an unsupported construct can never be
 * silently dropped from someone's repo.
 */

export type FrontmatterValue =
  | string
  | number
  | boolean
  | null
  | FrontmatterValue[]
  | { [key: string]: FrontmatterValue };

export interface FrontmatterRecord {
  [key: string]: FrontmatterValue;
}

export interface ParsedFile {
  data: FrontmatterRecord;
  body: string;
  hasFrontmatter: boolean;
  /** Raw frontmatter text between the `---` fences, kept so we can detect lossy rewrites. */
  rawFrontmatter: string;
  /** Line ending detected in the source, reused when serialising. */
  eol: '\n' | '\r\n';
}

const FENCE = '---';

interface Cursor {
  lines: string[];
  i: number;
}

// ── parsing ───────────────────────────────────────────────────────────────────

/**
 * Split a Markdown/MDX file into frontmatter data and body.
 * Files without a leading `---` fence come back as `{ data: {}, body: <whole file> }`.
 */
export function parseFrontmatter(raw: string): ParsedFile {
  const eol: '\n' | '\r\n' = raw.includes('\r\n') ? '\r\n' : '\n';
  const normalized = raw.replace(/\r\n/g, '\n');
  // A BOM before the fence is common in Windows-authored content files.
  const text = normalized.charCodeAt(0) === 0xfeff ? normalized.slice(1) : normalized;

  const lines = text.split('\n');
  if (lines.length < 2 || lines[0].trim() !== FENCE) {
    return { data: {}, body: text, hasFrontmatter: false, rawFrontmatter: '', eol };
  }

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === FENCE || lines[i].trim() === '...') {
      end = i;
      break;
    }
  }
  if (end === -1) {
    // Unterminated fence: treat the whole file as body rather than guessing.
    return { data: {}, body: text, hasFrontmatter: false, rawFrontmatter: '', eol };
  }

  const rawFrontmatter = lines.slice(1, end).join('\n');
  const body = lines.slice(end + 1).join('\n').replace(/^\n/, '');
  return { data: parseYamlMap(rawFrontmatter), body, hasFrontmatter: true, rawFrontmatter, eol };
}

/** Parse a standalone YAML mapping (the text between the `---` fences). */
export function parseYamlMap(source: string): FrontmatterRecord {
  const cursor: Cursor = { lines: source.split('\n'), i: 0 };
  skipIgnorable(cursor);
  if (cursor.i >= cursor.lines.length) return {};
  const value = parseNode(cursor, indentOf(cursor.lines[cursor.i]));
  return isRecordValue(value) ? value : {};
}

function indentOf(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === ' ') n++;
  return n;
}

function isBlank(line: string): boolean {
  return line.trim() === '';
}

function isComment(line: string): boolean {
  return line.trim().startsWith('#');
}

function skipIgnorable(cursor: Cursor): void {
  while (cursor.i < cursor.lines.length && (isBlank(cursor.lines[cursor.i]) || isComment(cursor.lines[cursor.i]))) {
    cursor.i++;
  }
}

function parseNode(cursor: Cursor, indent: number): FrontmatterValue {
  skipIgnorable(cursor);
  if (cursor.i >= cursor.lines.length) return null;
  const line = cursor.lines[cursor.i];
  return /^\s*-(\s|$)/.test(line) ? parseSequence(cursor, indent) : parseMapping(cursor, indent);
}

function parseMapping(cursor: Cursor, indent: number): FrontmatterRecord {
  const out: FrontmatterRecord = {};
  while (true) {
    skipIgnorable(cursor);
    if (cursor.i >= cursor.lines.length) break;
    const line = cursor.lines[cursor.i];
    const ind = indentOf(line);
    if (ind < indent) break;
    if (ind > indent) {
      // Unexpected deeper line at this level (malformed input). Skip it so we always progress.
      cursor.i++;
      continue;
    }
    if (/^\s*-(\s|$)/.test(line)) break;

    const entry = splitKey(line.slice(ind));
    if (!entry) {
      cursor.i++;
      continue;
    }
    cursor.i++;
    out[entry.key] = parseEntryValue(cursor, indent, entry.rest);
  }
  return out;
}

/** Value for `key: <rest>` — either inline, a block scalar, or a nested block on following lines. */
function parseEntryValue(cursor: Cursor, indent: number, rest: string): FrontmatterValue {
  const trimmed = rest.trim();
  if (trimmed.startsWith('|') || trimmed.startsWith('>')) {
    return parseBlockScalar(cursor, indent, trimmed);
  }
  if (trimmed !== '' && !trimmed.startsWith('#')) {
    return parseScalar(trimmed);
  }

  const save = cursor.i;
  skipIgnorable(cursor);
  if (cursor.i >= cursor.lines.length) {
    cursor.i = save;
    return null;
  }
  const next = cursor.lines[cursor.i];
  const nextIndent = indentOf(next);
  const isSeq = /^\s*-(\s|$)/.test(next);
  // A sequence may sit at the parent's own indent — `tags:` followed by `- a` in column 0.
  if (isSeq && nextIndent >= indent) return parseSequence(cursor, nextIndent);
  if (nextIndent > indent) return parseNode(cursor, nextIndent);
  cursor.i = save;
  return null;
}

function parseSequence(cursor: Cursor, indent: number): FrontmatterValue[] {
  const out: FrontmatterValue[] = [];
  while (true) {
    skipIgnorable(cursor);
    if (cursor.i >= cursor.lines.length) break;
    const line = cursor.lines[cursor.i];
    const ind = indentOf(line);
    if (ind !== indent || !/^\s*-(\s|$)/.test(line)) break;

    const after = line.slice(ind + 1);
    const content = after.replace(/^\s/, '');
    const contentIndent = ind + 1 + (after.length - content.length);

    if (content.trim() === '' || content.trim().startsWith('#')) {
      cursor.i++;
      skipIgnorable(cursor);
      if (cursor.i < cursor.lines.length && indentOf(cursor.lines[cursor.i]) > indent) {
        out.push(parseNode(cursor, indentOf(cursor.lines[cursor.i])));
      } else {
        out.push(null);
      }
      continue;
    }

    const entry = splitKey(content);
    if (entry) {
      // `- key: value` starts a mapping whose first key sits where the content began.
      // Rewriting the dash to spaces lets the ordinary mapping parser handle the rest.
      cursor.lines[cursor.i] = ' '.repeat(contentIndent) + content;
      out.push(parseMapping(cursor, contentIndent));
      continue;
    }

    cursor.i++;
    out.push(parseScalar(content.trim()));
  }
  return out;
}

function parseBlockScalar(cursor: Cursor, indent: number, header: string): string {
  const folded = header.startsWith('>');
  const chomp: 'clip' | 'strip' | 'keep' = header.includes('-') ? 'strip' : header.includes('+') ? 'keep' : 'clip';

  const raw: string[] = [];
  let blockIndent = -1;
  while (cursor.i < cursor.lines.length) {
    const line = cursor.lines[cursor.i];
    if (isBlank(line)) {
      raw.push('');
      cursor.i++;
      continue;
    }
    const ind = indentOf(line);
    if (ind <= indent) break;
    if (blockIndent === -1) blockIndent = ind;
    raw.push(line.slice(Math.min(ind, blockIndent)));
    cursor.i++;
  }
  while (raw.length && raw[raw.length - 1] === '') raw.pop();

  let text: string;
  if (folded) {
    // Folded: single newlines become spaces, blank lines become real newlines.
    const parts: string[] = [];
    let current = '';
    for (const line of raw) {
      if (line === '') {
        parts.push(current);
        current = '';
      } else {
        current = current ? `${current} ${line}` : line;
      }
    }
    parts.push(current);
    text = parts.join('\n');
  } else {
    text = raw.join('\n');
  }

  if (chomp === 'keep' || chomp === 'clip') text += '\n';
  return text;
}

interface KeySplit {
  key: string;
  rest: string;
}

/** Split `key: value`, honouring quoted keys. Returns null when the line is not a mapping entry. */
function splitKey(line: string): KeySplit | null {
  const trimmed = line.trimStart();
  if (trimmed === '' || trimmed.startsWith('#')) return null;

  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed[0];
    const end = findClosingQuote(trimmed, quote);
    if (end === -1) return null;
    const after = trimmed.slice(end + 1).trimStart();
    if (!after.startsWith(':')) return null;
    return { key: parseQuoted(trimmed.slice(0, end + 1), quote), rest: after.slice(1) };
  }

  const colon = trimmed.indexOf(':');
  if (colon === -1) return null;
  const key = trimmed.slice(0, colon).trim();
  if (key === '') return null;
  const rest = trimmed.slice(colon + 1);
  // `key:value` with no space is not a YAML mapping entry — treat it as a plain scalar line.
  if (rest !== '' && !rest.startsWith(' ')) return null;
  return { key, rest };
}

function findClosingQuote(text: string, quote: string): number {
  for (let i = 1; i < text.length; i++) {
    if (text[i] === '\\' && quote === '"') {
      i++;
      continue;
    }
    if (text[i] === quote) {
      if (quote === "'" && text[i + 1] === "'") {
        i++;
        continue;
      }
      return i;
    }
  }
  return -1;
}

function parseQuoted(token: string, quote: string): string {
  const inner = token.slice(1, -1);
  if (quote === "'") return inner.replace(/''/g, "'");
  return unescapeDoubleQuoted(inner);
}

function unescapeDoubleQuoted(inner: string): string {
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = inner[++i];
    switch (next) {
      case 'n':
        out += '\n';
        break;
      case 't':
        out += '\t';
        break;
      case 'r':
        out += '\r';
        break;
      case 'b':
        out += '\b';
        break;
      case 'f':
        out += '\f';
        break;
      case '0':
        out += '\0';
        break;
      case 'u': {
        const hex = inner.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else {
          out += 'u';
        }
        break;
      }
      case undefined:
        out += '\\';
        break;
      default:
        out += next;
        break;
    }
  }
  return out;
}

const NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

export function parseScalar(input: string): FrontmatterValue {
  const token = stripInlineComment(input).trim();
  if (token === '' || token === '~') return null;

  const first = token[0];
  if (first === '"' || first === "'") {
    const end = findClosingQuote(token, first);
    if (end === token.length - 1) return parseQuoted(token, first);
  }
  if (first === '[') return parseFlowSequence(token);
  if (first === '{') return parseFlowMapping(token);

  const lower = token.toLowerCase();
  if (lower === 'null') return null;
  if (lower === 'true') return true;
  if (lower === 'false') return false;

  // Only treat a token as a number when it survives the round-trip, so long ids
  // and zero-padded values stay strings instead of losing precision.
  if (NUMBER_RE.test(token) && String(Number(token)) === token) return Number(token);

  return token;
}

/** Remove a trailing ` # comment`, but never inside quotes. */
function stripInlineComment(input: string): string {
  let quote: string | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(input[i - 1]))) return input.slice(0, i);
  }
  return input;
}

/** Split `a, b, [c, d]` on top-level commas only. */
function splitFlow(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      current += ch;
      if (ch === '\\' && quote === '"') {
        if (i + 1 < inner.length) current += inner[++i];
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '[' || ch === '{') depth++;
    if (ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim() !== '') parts.push(current);
  return parts;
}

function parseFlowSequence(token: string): FrontmatterValue[] {
  const inner = token.slice(1, token.lastIndexOf(']') === -1 ? undefined : token.lastIndexOf(']'));
  if (inner.trim() === '') return [];
  return splitFlow(inner).map((part) => parseScalar(part.trim()));
}

function parseFlowMapping(token: string): FrontmatterRecord {
  const close = token.lastIndexOf('}');
  const inner = token.slice(1, close === -1 ? undefined : close);
  const out: FrontmatterRecord = {};
  if (inner.trim() === '') return out;
  for (const part of splitFlow(inner)) {
    const entry = splitKey(part.trim());
    if (entry) out[entry.key] = parseScalar(entry.rest.trim());
    else {
      const colon = part.indexOf(':');
      if (colon > 0) out[part.slice(0, colon).trim()] = parseScalar(part.slice(colon + 1).trim());
    }
  }
  return out;
}

// ── serialising ───────────────────────────────────────────────────────────────

/** Rebuild a full file from frontmatter data + body. */
export function serializeFrontmatter(data: FrontmatterRecord, body: string, eol: '\n' | '\r\n' = '\n'): string {
  const block = stringifyYamlMap(data);
  const parts = block === '' ? [FENCE, FENCE, ''] : [FENCE, block, FENCE, ''];
  const head = parts.join('\n');
  const out = body ? `${head}\n${body}` : head;
  return eol === '\r\n' ? out.replace(/\n/g, '\r\n') : out;
}

/** Serialise a mapping to YAML text (no fences). Key order is preserved. */
export function stringifyYamlMap(data: FrontmatterRecord, indent = 0): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    pushEntry(lines, key, value, indent);
  }
  return lines.join('\n');
}

function pushEntry(lines: string[], key: string, value: FrontmatterValue, indent: number): void {
  const pad = ' '.repeat(indent);
  const k = formatKey(key);

  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${pad}${k}: []`);
      return;
    }
    lines.push(`${pad}${k}:`);
    for (const item of value) pushSequenceItem(lines, item, indent + 2);
    return;
  }

  if (isRecordValue(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      lines.push(`${pad}${k}: {}`);
      return;
    }
    lines.push(`${pad}${k}:`);
    for (const [childKey, childValue] of entries) pushEntry(lines, childKey, childValue, indent + 2);
    return;
  }

  lines.push(`${pad}${k}: ${formatScalar(value)}`);
}

function pushSequenceItem(lines: string[], value: FrontmatterValue, indent: number): void {
  const pad = ' '.repeat(indent);

  if (isRecordValue(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      lines.push(`${pad}- {}`);
      return;
    }
    const nested: string[] = [];
    for (const [k, v] of entries) pushEntry(nested, k, v, indent + 2);
    // First key rides on the dash line; the rest keep the deeper indent.
    lines.push(`${pad}- ${nested[0].slice(indent + 2)}`);
    for (let i = 1; i < nested.length; i++) lines.push(nested[i]);
    return;
  }

  if (Array.isArray(value)) {
    // Nested sequences are rare in frontmatter; flow style keeps them unambiguous.
    lines.push(`${pad}- ${formatFlow(value)}`);
    return;
  }

  lines.push(`${pad}- ${formatScalar(value)}`);
}

function formatKey(key: string): string {
  return /^[A-Za-z0-9_][A-Za-z0-9_.\-/]*$/.test(key) ? key : JSON.stringify(key);
}

function formatFlow(value: FrontmatterValue): string {
  if (Array.isArray(value)) return `[${value.map((v) => formatFlow(v)).join(', ')}]`;
  if (isRecordValue(value)) {
    const inner = Object.entries(value)
      .map(([k, v]) => `${formatKey(k)}: ${formatFlow(v)}`)
      .join(', ');
    return `{${inner}}`;
  }
  return formatScalar(value, true);
}

const RESERVED_WORDS = new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off', '~']);

function formatScalar(value: FrontmatterValue, flowContext = false): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value !== 'string') return 'null';
  return needsQuoting(value, flowContext) ? JSON.stringify(value) : value;
}

function needsQuoting(text: string, flowContext: boolean): boolean {
  if (text === '') return true;
  if (text !== text.trim()) return true;
  if (RESERVED_WORDS.has(text.toLowerCase())) return true;
  if (NUMBER_RE.test(text)) return true;
  if (/[\n\r\t"]/.test(text)) return true;
  if (/^[-?:,[\]{}#&*!|>'%@`]/.test(text)) return true;
  if (/:\s/.test(text) || text.endsWith(':')) return true;
  if (/\s#/.test(text)) return true;
  if (flowContext && /[,[\]{}]/.test(text)) return true;
  return false;
}

export function isRecordValue(value: FrontmatterValue | undefined): value is FrontmatterRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True when `data` survives a serialise→parse cycle unchanged.
 *
 * The git adapter calls this before pushing a rewritten file: if the source used
 * a YAML construct this parser does not model, we refuse the write instead of
 * committing a file that silently lost data.
 */
export function roundTripsCleanly(data: FrontmatterRecord): boolean {
  try {
    const reparsed = parseYamlMap(stringifyYamlMap(data));
    return stableStringify(reparsed) === stableStringify(data);
  } catch {
    return false;
  }
}

function stableStringify(value: FrontmatterValue): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isRecordValue(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
