import { ImapFlow, type ListResponse, type FetchMessageObject } from 'imapflow';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import { createLogger, errorMessage } from '@seo/shared';
import { formatAddress } from './compose';
import { parseRawMessage, snippetOf } from './parse';
import {
  MailError,
  type ImapSmtpConfig,
  type ListQuery,
  type MailAdapter,
  type MailAddress,
  type MailFolder,
  type MailPage,
  type MailSummary,
  type OutgoingMessage,
  type SpecialFolder,
} from './types';

/**
 * IMAP to read, SMTP to send.
 *
 * One adapter instance is one connection for one request: the web app is request/response, so a
 * pool of idle IMAP sessions would only hold sockets open on the provider for nothing. The
 * caller always closes it (`withMailAdapter` in the web layer does so in a finally).
 */

const log = createLogger('mail:imap');

const SPECIAL_USE: Record<string, SpecialFolder> = {
  '\\Inbox': 'inbox',
  '\\Sent': 'sent',
  '\\Drafts': 'drafts',
  '\\Trash': 'trash',
  '\\Junk': 'junk',
  '\\Archive': 'archive',
  '\\All': 'all',
  '\\Flagged': 'flagged',
};

/** Folder order in the sidebar: the ones people use first. */
const FOLDER_ORDER: Array<SpecialFolder | null> = ['inbox', 'flagged', 'sent', 'drafts', 'archive', 'all', 'junk', 'trash', null];

const MAX_PAGE = 100;

function mapImapError(err: unknown): MailError {
  if (err instanceof MailError) return err;
  const message = errorMessage(err);
  const details = err as { authenticationFailed?: boolean; responseText?: string; code?: string };
  if (details.authenticationFailed || /auth|login|credentials|password/i.test(details.responseText ?? message)) {
    return new MailError('AUTH', `The mail server refused the login: ${details.responseText ?? message}`, 'Check the address and use an app password (not your normal password).');
  }
  if (details.code === 'ENOTFOUND' || details.code === 'ECONNREFUSED' || details.code === 'ETIMEDOUT' || /timeout|ECONN|getaddrinfo/i.test(message)) {
    return new MailError('CONNECTION', `Could not reach the mail server: ${message}`, 'Check the server name and port.');
  }
  return new MailError('UPSTREAM', message);
}

function addressList(value: unknown): MailAddress[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    const record = entry as { name?: unknown; address?: unknown };
    return typeof record.address === 'string' && record.address
      ? [{ name: typeof record.name === 'string' && record.name.trim() ? record.name.trim() : null, address: record.address }]
      : [];
  });
}

function isoDate(value: unknown): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function summaryOf(message: FetchMessageObject): MailSummary {
  const envelope = message.envelope;
  const flags = message.flags ?? new Set<string>();
  const structure = JSON.stringify(message.bodyStructure ?? {});
  return {
    id: String(message.uid),
    threadId: message.threadId ?? null,
    from: addressList(envelope?.from)[0] ?? null,
    to: addressList(envelope?.to),
    subject: envelope?.subject ?? '',
    snippet: '',
    date: isoDate(envelope?.date) ?? isoDate(message.internalDate),
    seen: flags.has('\\Seen'),
    flagged: flags.has('\\Flagged'),
    hasAttachments: /"disposition":"attachment"/i.test(structure),
  };
}

export class ImapSmtpAdapter implements MailAdapter {
  private client: ImapFlow | null = null;
  private folders: MailFolder[] | null = null;

  constructor(
    private readonly email: string,
    private readonly password: string,
    private readonly config: ImapSmtpConfig,
  ) {}

  private get username(): string {
    return this.config.username?.trim() || this.email;
  }

  private async imap(): Promise<ImapFlow> {
    if (this.client) return this.client;
    const client = new ImapFlow({
      host: this.config.imap.host,
      port: this.config.imap.port,
      secure: this.config.imap.secure,
      auth: { user: this.username, pass: this.password },
      logger: false,
      connectionTimeout: 20_000,
      greetingTimeout: 15_000,
    });
    // An unhandled 'error' event would crash the process; failures surface through the awaited calls.
    client.on('error', (err: unknown) => log.debug('imap connection error', { error: errorMessage(err) }));
    try {
      await client.connect();
    } catch (err) {
      throw mapImapError(err);
    }
    this.client = client;
    return client;
  }

  private async withFolder<T>(path: string, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = await this.imap();
    let lock;
    try {
      lock = await client.getMailboxLock(path);
    } catch (err) {
      throw new MailError('NOT_FOUND', `Folder "${path}" does not exist: ${errorMessage(err)}`);
    }
    try {
      return await fn(client);
    } catch (err) {
      throw mapImapError(err);
    } finally {
      lock.release();
    }
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    await this.imap();
    const transport = this.transport();
    try {
      await transport.verify();
    } catch (err) {
      throw new MailError('AUTH', `Reading works, but the SMTP server refused to send: ${errorMessage(err)}`, 'Check the SMTP server and port.');
    } finally {
      transport.close();
    }
    return { ok: true, message: `Connected to ${this.config.imap.host} (read) and ${this.config.smtp.host} (send).` };
  }

  async listFolders(): Promise<MailFolder[]> {
    if (this.folders) return this.folders;
    const client = await this.imap();
    let list: ListResponse[];
    try {
      list = await client.list({ statusQuery: { unseen: true, messages: true } });
    } catch (err) {
      throw mapImapError(err);
    }
    const folders = list
      .filter((entry) => !entry.flags.has('\\Noselect'))
      .map((entry): MailFolder => ({
        path: entry.path,
        name: entry.path.toUpperCase() === 'INBOX' ? 'Inbox' : entry.name,
        specialUse: entry.path.toUpperCase() === 'INBOX' ? 'inbox' : (entry.specialUse ? SPECIAL_USE[entry.specialUse] ?? null : null),
        unread: entry.status?.unseen ?? null,
        total: entry.status?.messages ?? null,
      }))
      .sort((a, b) => FOLDER_ORDER.indexOf(a.specialUse) - FOLDER_ORDER.indexOf(b.specialUse) || a.name.localeCompare(b.name));
    this.folders = folders;
    return folders;
  }

  private async specialFolder(kind: SpecialFolder): Promise<string | null> {
    return (await this.listFolders()).find((folder) => folder.specialUse === kind)?.path ?? null;
  }

  async listMessages(query: ListQuery): Promise<MailPage> {
    const pageSize = Math.min(Math.max(1, query.pageSize ?? 50), MAX_PAGE);
    const page = Math.max(0, Number.parseInt(query.cursor ?? '0', 10) || 0);
    return this.withFolder(query.folder, async (client) => {
      const fetchQuery = { uid: true, envelope: true, flags: true, internalDate: true, bodyStructure: true, threadId: true } as const;
      let uids: number[];
      if (query.query?.trim()) {
        const q = query.query.trim();
        // Gmail understands its own search syntax over IMAP; everyone else gets a subject/from/body OR.
        const criteria = this.config.imap.host === 'imap.gmail.com' ? { gmraw: q } : { or: [{ subject: q }, { from: q }, { body: q }] };
        const found = await client.search(criteria, { uid: true });
        uids = (found || []).sort((a, b) => b - a);
      } else {
        const exists = client.mailbox && typeof client.mailbox === 'object' ? client.mailbox.exists : 0;
        if (!exists) return { messages: [], total: 0, nextCursor: null };
        const end = exists - page * pageSize;
        if (end < 1) return { messages: [], total: exists, nextCursor: null };
        const start = Math.max(1, end - pageSize + 1);
        const messages: MailSummary[] = [];
        for await (const message of client.fetch(`${start}:${end}`, fetchQuery)) messages.push(summaryOf(message));
        messages.sort((a, b) => Number(b.id) - Number(a.id));
        return { messages, total: exists, nextCursor: start > 1 ? String(page + 1) : null };
      }
      const slice = uids.slice(page * pageSize, (page + 1) * pageSize);
      const messages: MailSummary[] = [];
      if (slice.length) {
        for await (const message of client.fetch(slice.join(','), fetchQuery, { uid: true })) messages.push(summaryOf(message));
      }
      messages.sort((a, b) => Number(b.id) - Number(a.id));
      return {
        messages,
        total: uids.length,
        nextCursor: (page + 1) * pageSize < uids.length ? String(page + 1) : null,
      };
    });
  }

  async getMessage(folder: string, id: string, opts: { peek?: boolean } = {}) {
    return this.withFolder(folder, async (client) => {
      const message = await client.fetchOne(id, { uid: true, source: true, flags: true, threadId: true }, { uid: true });
      if (!message || !message.source) throw new MailError('NOT_FOUND', 'That message no longer exists in this folder.');
      const flags = message.flags ?? new Set<string>();
      if (!opts.peek && !flags.has('\\Seen')) {
        await client.messageFlagsAdd(id, ['\\Seen'], { uid: true });
        flags.add('\\Seen');
      }
      const parsed = await parseRawMessage(message.source, {
        id,
        threadId: message.threadId ?? null,
        seen: flags.has('\\Seen'),
        flagged: flags.has('\\Flagged'),
      });
      return { ...parsed, snippet: parsed.snippet || snippetOf(parsed.text) };
    });
  }

  async setFlags(folder: string, ids: readonly string[], flags: { seen?: boolean; flagged?: boolean }): Promise<void> {
    if (ids.length === 0) return;
    await this.withFolder(folder, async (client) => {
      const range = ids.join(',');
      for (const [flag, value] of [['\\Seen', flags.seen], ['\\Flagged', flags.flagged]] as const) {
        if (value === true) await client.messageFlagsAdd(range, [flag], { uid: true });
        if (value === false) await client.messageFlagsRemove(range, [flag], { uid: true });
      }
    });
  }

  async move(folder: string, ids: readonly string[], target: 'archive' | 'trash' | { path: string }): Promise<void> {
    if (ids.length === 0) return;
    let destination: string | null;
    if (typeof target === 'object') destination = target.path;
    else if (target === 'trash') destination = await this.specialFolder('trash');
    // Gmail has no Archive folder: archiving is leaving the inbox, i.e. living only in All Mail.
    else destination = (await this.specialFolder('archive')) ?? (await this.specialFolder('all'));
    if (!destination) {
      throw new MailError('NOT_FOUND', `This mailbox has no ${typeof target === 'string' ? target : 'target'} folder.`);
    }
    await this.withFolder(folder, async (client) => {
      await client.messageMove(ids.join(','), destination, { uid: true });
    });
  }

  private transport() {
    return nodemailer.createTransport({
      host: this.config.smtp.host,
      port: this.config.smtp.port,
      secure: this.config.smtp.secure,
      requireTLS: !this.config.smtp.secure,
      auth: { user: this.username, pass: this.password },
      connectionTimeout: 20_000,
    });
  }

  async send(message: OutgoingMessage): Promise<{ messageId: string | null }> {
    // Build the MIME once so the copy filed in Sent is byte-for-byte what was delivered.
    const composer = new MailComposer({
      from: formatAddress(message.from),
      to: message.to.map(formatAddress),
      cc: message.cc.map(formatAddress),
      bcc: message.bcc.map(formatAddress),
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
      ...(message.inReplyTo ? { inReplyTo: message.inReplyTo } : {}),
      ...(message.references?.length ? { references: message.references } : {}),
      attachments: (message.attachments ?? []).map((attachment) => ({
        filename: attachment.filename,
        contentType: attachment.contentType,
        content: attachment.content,
      })),
    });
    const mail = composer.compile();
    mail.keepBcc = false;
    const raw = await mail.build();
    const envelope = mail.getEnvelope();

    const transport = this.transport();
    let messageId: string | null = null;
    try {
      const info = await transport.sendMail({ envelope, raw });
      messageId = info.messageId ?? mail.messageId() ?? null;
    } catch (err) {
      throw new MailError('UPSTREAM', `The SMTP server refused the message: ${errorMessage(err)}`);
    } finally {
      transport.close();
    }

    if (!this.config.smtpSavesSent) {
      try {
        const sent = await this.specialFolder('sent');
        if (sent) await (await this.imap()).append(sent, raw, ['\\Seen']);
      } catch (err) {
        // Delivered is what matters; a missing Sent copy is reported in the log, not as a failure.
        log.warn('message sent but could not be filed in Sent', { error: errorMessage(err) });
      }
    }
    return { messageId };
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) return;
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }
}
