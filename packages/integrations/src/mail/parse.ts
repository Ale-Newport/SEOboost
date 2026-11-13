import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import { truncate } from '@seo/shared';
import type { MailAddress, MailMessage } from './types';

/**
 * Raw RFC 822 → `MailMessage`. Shared by IMAP (BODY[]) and Gmail (format=raw), so both providers
 * produce exactly the same shape and the same threading headers.
 */

function addresses(value: AddressObject | AddressObject[] | undefined): MailAddress[] {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list.flatMap((group) =>
    group.value.flatMap((entry) => (entry.address ? [{ name: entry.name?.trim() || null, address: entry.address }] : [])),
  );
}

function references(parsed: ParsedMail): string[] {
  const raw = parsed.references;
  const list = Array.isArray(raw) ? raw : raw ? raw.split(/\s+/) : [];
  return list.map((value) => value.trim()).filter(Boolean);
}

export function snippetOf(text: string): string {
  return truncate(text.replace(/\s+/g, ' ').trim(), 160);
}

export async function parseRawMessage(
  raw: Buffer | string,
  meta: { id: string; threadId: string | null; seen: boolean; flagged: boolean },
): Promise<MailMessage> {
  const parsed = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true });
  const text = parsed.text ?? '';
  const html = typeof parsed.html === 'string' ? parsed.html : null;
  const attachments = parsed.attachments
    .filter((attachment) => attachment.contentDisposition !== 'inline' || !attachment.cid)
    .map((attachment) => ({
      filename: attachment.filename ?? 'attachment',
      contentType: attachment.contentType,
      size: attachment.size,
    }));
  const from = addresses(parsed.from)[0] ?? null;
  return {
    id: meta.id,
    threadId: meta.threadId,
    from,
    to: addresses(parsed.to),
    cc: addresses(parsed.cc),
    replyTo: addresses(parsed.replyTo),
    subject: parsed.subject ?? '',
    snippet: snippetOf(text),
    date: parsed.date ? parsed.date.toISOString() : null,
    seen: meta.seen,
    flagged: meta.flagged,
    hasAttachments: attachments.length > 0,
    messageId: parsed.messageId ?? null,
    inReplyTo: parsed.inReplyTo ?? null,
    references: references(parsed),
    text,
    html,
    attachments,
  };
}
