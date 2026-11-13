import type { MailAddress, MailMessage, OutgoingMessage } from './types';

/**
 * Pure helpers for replies and forwards.
 *
 * Threading only works when `In-Reply-To` and `References` are right: Gmail, Outlook and every
 * other client group messages by them, and a reply that loses them lands as a new conversation.
 */

const REPLY_PREFIX = /^\s*(re|aw|sv|antw|r)\s*(\[\d+\])?\s*:\s*/i;
const FORWARD_PREFIX = /^\s*(fwd?|fw|rv|wg|tr)\s*:\s*/i;

/** `Re: <subject>` without stacking ("Re: Re: Re:"). */
export function replySubject(subject: string): string {
  const base = subject.trim();
  return REPLY_PREFIX.test(base) ? base : `Re: ${base || '(no subject)'}`;
}

/** `Fwd: <subject>` without stacking. */
export function forwardSubject(subject: string): string {
  const base = subject.trim();
  return FORWARD_PREFIX.test(base) ? base : `Fwd: ${base || '(no subject)'}`;
}

/** The References chain for a reply: the original's chain plus the original itself, deduplicated. */
export function buildReferences(original: Pick<MailMessage, 'references' | 'messageId' | 'inReplyTo'>): string[] {
  const chain = [...original.references];
  if (chain.length === 0 && original.inReplyTo) chain.push(original.inReplyTo);
  if (original.messageId) chain.push(original.messageId);
  return [...new Set(chain.filter(Boolean))];
}

const ADDRESS = /^[^\s@<>(),;:"[\]]+@[^\s@<>(),;:"[\]]+\.[^\s@<>(),;:"[\]]{2,}$/;

export function isValidAddress(address: string): boolean {
  return ADDRESS.test(address.trim());
}

/**
 * Parse a recipient field as people type it: comma/semicolon separated, each either a bare
 * address or `Name <address>`. Invalid entries are returned separately so the form can point at
 * them instead of silently dropping a recipient.
 */
export function parseRecipients(input: string): { valid: MailAddress[]; invalid: string[] } {
  const valid: MailAddress[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.split(/[,;\n]/)) {
    const part = raw.trim();
    if (!part) continue;
    const angled = part.match(/^(.*?)\s*<([^>]+)>$/);
    const name = angled ? angled[1]!.replace(/^"|"$/g, '').trim() || null : null;
    const address = (angled ? angled[2]! : part).trim();
    if (!isValidAddress(address)) {
      invalid.push(part);
      continue;
    }
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    valid.push({ name, address });
  }
  return { valid, invalid };
}

export function formatAddress(address: MailAddress): string {
  return address.name ? `${address.name} <${address.address}>` : address.address;
}

function quote(original: MailMessage): string {
  const when = original.date ? new Date(original.date).toUTCString() : 'an earlier date';
  const who = original.from ? formatAddress(original.from) : 'the sender';
  const body = original.text.trim().split('\n').map((line) => `> ${line}`).join('\n');
  return `On ${when}, ${who} wrote:\n${body}`;
}

function forwardBlock(original: MailMessage): string {
  return [
    '---------- Forwarded message ---------',
    `From: ${original.from ? formatAddress(original.from) : ''}`,
    `Date: ${original.date ?? ''}`,
    `Subject: ${original.subject}`,
    `To: ${original.to.map(formatAddress).join(', ')}`,
    '',
    original.text.trim(),
  ].join('\n');
}

export type ReplyMode = 'reply' | 'replyAll' | 'forward';

/**
 * Who a reply goes to. Reply-to wins over From (mailing lists rely on it); reply-all adds every
 * other recipient except ourselves.
 */
export function replyRecipients(
  original: MailMessage,
  mode: Exclude<ReplyMode, 'forward'>,
  self: string,
): { to: MailAddress[]; cc: MailAddress[] } {
  const me = self.toLowerCase();
  const primary = original.replyTo.length ? original.replyTo : original.from ? [original.from] : [];
  const to = primary.filter((address) => address.address.toLowerCase() !== me);
  if (mode === 'reply') return { to: to.length ? to : primary, cc: [] };
  const taken = new Set([...to.map((address) => address.address.toLowerCase()), me]);
  const cc = [...original.to, ...original.cc].filter((address) => {
    const key = address.address.toLowerCase();
    if (taken.has(key)) return false;
    taken.add(key);
    return true;
  });
  return { to: to.length ? to : primary, cc };
}

/**
 * Build the outgoing message for a reply or forward. Recipients come from the form (the user may
 * have edited the defaults); subject, quoting and threading headers come from the original.
 */
export function buildResponse(input: {
  mode: ReplyMode;
  original: MailMessage;
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  body: string;
  subject?: string | null;
}): OutgoingMessage {
  const { original } = input;
  const forwarding = input.mode === 'forward';
  return {
    from: input.from,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject?.trim() || (forwarding ? forwardSubject(original.subject) : replySubject(original.subject)),
    text: `${input.body.trim()}\n\n${forwarding ? forwardBlock(original) : quote(original)}\n`,
    ...(forwarding
      ? {}
      : {
          inReplyTo: original.messageId,
          references: buildReferences(original),
          threadId: original.threadId,
        }),
  };
}
