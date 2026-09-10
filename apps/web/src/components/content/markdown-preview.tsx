'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * A deliberately small markdown renderer.
 *
 * It produces React elements rather than an HTML string, so there is no `dangerouslySetInnerHTML`
 * anywhere in the editor: a draft is written by a model and may contain anything, and the preview
 * is the one place that content would otherwise become live markup. Link targets are additionally
 * restricted to http(s), mailto and site-relative paths, because `[click](javascript:…)` is valid
 * markdown.
 *
 * It covers what the pipeline actually emits — headings, paragraphs, lists, quotes, fenced code,
 * tables, rules — and renders anything else as plain text rather than guessing.
 */

// ── inline ───────────────────────────────────────────────────

const SAFE_PROTOCOL = /^(?:https?:|mailto:|tel:)/i;

function safeHref(href: string): string | null {
  const trimmed = href.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith('/') || trimmed.startsWith('#')) return trimmed;
  return SAFE_PROTOCOL.test(trimmed) ? trimmed : null;
}

/** `[VERIFY: …]` markers the writer leaves behind must be impossible to miss in the preview. */
const INLINE_PATTERN =
  /(\[VERIFY:[^\]]*\])|(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(~~[^~]+~~)|(!?\[[^\]]*\]\([^)\s]+(?:\s+"[^"]*")?\))/;

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let rest = text;
  let index = 0;

  while (rest.length > 0) {
    const match = INLINE_PATTERN.exec(rest);
    if (!match || match.index === undefined) {
      nodes.push(rest);
      break;
    }

    if (match.index > 0) nodes.push(rest.slice(0, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${index++}`;

    if (token.startsWith('[VERIFY:')) {
      nodes.push(
        <mark
          key={key}
          className="rounded-sm bg-destructive/15 px-1 py-0.5 font-medium text-destructive"
          title="The writer refused to invent this fact and left a marker. Supply it, cite it, or delete the sentence."
        >
          {token}
        </mark>,
      );
    } else if (token.startsWith('`')) {
      nodes.push(
        <code key={key} className="rounded-sm bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('**') || token.startsWith('__')) {
      nodes.push(
        <strong key={key} className="font-semibold text-foreground">
          {renderInline(token.slice(2, -2), key)}
        </strong>,
      );
    } else if (token.startsWith('~~')) {
      nodes.push(
        <s key={key} className="text-muted-foreground">
          {renderInline(token.slice(2, -2), key)}
        </s>,
      );
    } else if (token.startsWith('*') || token.startsWith('_')) {
      nodes.push(<em key={key}>{renderInline(token.slice(1, -1), key)}</em>);
    } else {
      const link = /^(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/.exec(token);
      const label = link?.[2] ?? token;
      const href = link ? safeHref(link[3] ?? '') : null;
      if (link?.[1] === '!') {
        // Images are named, not rendered: a draft's image URLs are unverified third-party
        // requests, and the preview must not fire them.
        nodes.push(
          <span key={key} className="text-xs text-muted-foreground">
            [image: {label || 'untitled'}]
          </span>,
        );
      } else if (href === null) {
        nodes.push(<span key={key}>{label}</span>);
      } else {
        nodes.push(
          <a
            key={key}
            href={href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="font-medium text-primary underline underline-offset-2 hover:no-underline"
          >
            {label}
          </a>,
        );
      }
    }

    rest = rest.slice(match.index + token.length);
  }

  return nodes;
}

// ── blocks ───────────────────────────────────────────────────

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'code'; language: string | null; code: string }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'rule' };

function splitRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    if (line.trim().length === 0) {
      i++;
      continue;
    }

    const fence = /^\s{0,3}```(.*)$/.exec(line);
    if (fence) {
      const language = (fence[1] ?? '').trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s{0,3}```/.test(lines[i] ?? '')) {
        body.push(lines[i] ?? '');
        i++;
      }
      i++; // closing fence
      blocks.push({ kind: 'code', language: language.length > 0 ? language : null, code: body.join('\n') });
      continue;
    }

    if (/^\s{0,3}(?:[-*_]\s*){3,}$/.test(line)) {
      blocks.push({ kind: 'rule' });
      i++;
      continue;
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*$/.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: (heading[1] ?? '#').length, text: heading[2] ?? '' });
      i++;
      continue;
    }

    if (/^\s{0,3}>/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i] ?? '')) {
        quoted.push((lines[i] ?? '').replace(/^\s{0,3}>\s?/, ''));
        i++;
      }
      blocks.push({ kind: 'quote', lines: quoted });
      continue;
    }

    // A table needs a header row and the `---|---` separator directly under it.
    if (line.includes('|') && /^\s*\|?[\s:-]*-[\s|:-]*$/.test(lines[i + 1] ?? '')) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? '').includes('|') && (lines[i] ?? '').trim().length > 0) {
        rows.push(splitRow(lines[i] ?? ''));
        i++;
      }
      blocks.push({ kind: 'table', header, rows });
      continue;
    }

    const bullet = /^\s{0,3}([-*+])\s+(.*)$/.exec(line);
    const numbered = /^\s{0,3}(\d+)[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const ordered = numbered !== null;
      const items: string[] = [];
      while (i < lines.length) {
        const candidate = lines[i] ?? '';
        const next = ordered ? /^\s{0,3}\d+[.)]\s+(.*)$/.exec(candidate) : /^\s{0,3}[-*+]\s+(.*)$/.exec(candidate);
        if (next) {
          items.push(next[1] ?? '');
          i++;
          continue;
        }
        // An indented continuation line belongs to the item above it.
        if (/^\s{2,}\S/.test(candidate) && items.length > 0) {
          items[items.length - 1] = `${items[items.length - 1] ?? ''} ${candidate.trim()}`;
          i++;
          continue;
        }
        break;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length) {
      const candidate = lines[i] ?? '';
      if (
        candidate.trim().length === 0 ||
        /^\s{0,3}(#{1,6}\s|>|```|[-*+]\s|\d+[.)]\s)/.test(candidate) ||
        /^\s{0,3}(?:[-*_]\s*){3,}$/.test(candidate)
      ) {
        break;
      }
      paragraph.push(candidate.trim());
      i++;
    }
    blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
  }

  return blocks;
}

const HEADING_CLASS: Record<number, string> = {
  1: 'mt-6 text-xl font-semibold tracking-tight first:mt-0',
  2: 'mt-6 text-base font-semibold tracking-tight first:mt-0',
  3: 'mt-5 text-sm font-semibold tracking-tight first:mt-0',
  4: 'mt-4 text-sm font-semibold text-foreground/90 first:mt-0',
  5: 'mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground first:mt-0',
  6: 'mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground first:mt-0',
};

export interface MarkdownPreviewProps {
  markdown: string;
  className?: string;
}

export function MarkdownPreview({ markdown, className }: MarkdownPreviewProps): React.JSX.Element {
  const blocks = React.useMemo(() => parseBlocks(markdown), [markdown]);

  if (blocks.length === 0) {
    return (
      <p className={cn('text-sm italic text-muted-foreground', className)}>
        Nothing to preview yet — the draft body is empty.
      </p>
    );
  }

  return (
    <div className={cn('text-sm leading-relaxed text-foreground', className)}>
      {blocks.map((block, index) => {
        const key = `block-${index}`;
        switch (block.kind) {
          case 'heading': {
            const Tag = (`h${Math.min(6, Math.max(1, block.level))}` as 'h1');
            return (
              <Tag key={key} className={HEADING_CLASS[block.level] ?? HEADING_CLASS[3]}>
                {renderInline(block.text, key)}
              </Tag>
            );
          }
          case 'paragraph':
            return (
              <p key={key} className="mt-3 first:mt-0">
                {renderInline(block.text, key)}
              </p>
            );
          case 'list': {
            const Tag = block.ordered ? 'ol' : 'ul';
            return (
              <Tag
                key={key}
                className={cn(
                  'mt-3 space-y-1 pl-5 first:mt-0',
                  block.ordered ? 'list-decimal' : 'list-disc',
                  'marker:text-muted-foreground',
                )}
              >
                {block.items.map((item, itemIndex) => (
                  <li key={`${key}-${itemIndex}`}>{renderInline(item, `${key}-${itemIndex}`)}</li>
                ))}
              </Tag>
            );
          }
          case 'quote':
            return (
              <blockquote
                key={key}
                className="mt-3 border-l-2 border-border pl-3 text-muted-foreground first:mt-0"
              >
                {block.lines.map((quoted, quoteIndex) => (
                  <p key={`${key}-${quoteIndex}`}>{renderInline(quoted, `${key}-${quoteIndex}`)}</p>
                ))}
              </blockquote>
            );
          case 'code':
            return (
              <pre
                key={key}
                className="mt-3 overflow-x-auto rounded-md border border-border bg-muted/50 p-3 first:mt-0"
              >
                <code className="font-mono text-xs text-foreground">{block.code}</code>
              </pre>
            );
          case 'table':
            return (
              <div key={key} className="mt-3 overflow-x-auto first:mt-0">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr>
                      {block.header.map((cell, cellIndex) => (
                        <th
                          key={`${key}-h-${cellIndex}`}
                          scope="col"
                          className="border-b border-border px-2 py-1.5 text-left font-semibold"
                        >
                          {renderInline(cell, `${key}-h-${cellIndex}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={`${key}-r-${rowIndex}`}>
                        {row.map((cell, cellIndex) => (
                          <td
                            key={`${key}-r-${rowIndex}-${cellIndex}`}
                            className="border-b border-border/60 px-2 py-1.5 align-top"
                          >
                            {renderInline(cell, `${key}-r-${rowIndex}-${cellIndex}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'rule':
            return <hr key={key} className="my-5 border-border" />;
          default:
            return null;
        }
      })}
    </div>
  );
}
