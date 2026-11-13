import { google, type Auth, type gmail_v1 } from 'googleapis';
import MailComposer from 'nodemailer/lib/mail-composer';
import { env, errorMessage, isConfigured } from '@seo/shared';
import { constantTimeEquals, hashToken, randomToken } from '@seo/shared/crypto';
import { formatAddress } from './compose';
import { parseRawMessage } from './parse';
import {
  MailError,
  type ListQuery,
  type MailAdapter,
  type MailFolder,
  type MailPage,
  type MailSummary,
  type OutgoingMessage,
  type SpecialFolder,
} from './types';

/**
 * Gmail over its REST API, for installations that already have a Google OAuth client.
 *
 * IMAP with an app password needs no Google Cloud project and is the default; this path exists
 * because some Workspace domains disable app passwords. Labels play the role of folders, and
 * archiving is removing the INBOX label — exactly what the Gmail web client does.
 */

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const STATE_TTL_MS = 15 * 60_000;

export interface GmailCredentials {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}

export function isGmailOAuthAvailable(): boolean {
  return isConfigured.googleOAuth();
}

export function gmailRedirectUri(): string {
  return `${env.appUrl.replace(/\/$/, '')}/api/mail/gmail/callback`;
}

function oauthClient(): Auth.OAuth2Client {
  if (!env.googleClientId || !env.googleClientSecret) {
    throw new MailError('NOT_CONFIGURED', 'Gmail sign-in needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.', 'Use IMAP with an app password instead — it needs no Google Cloud setup.');
  }
  return new google.auth.OAuth2(env.googleClientId, env.googleClientSecret, gmailRedirectUri());
}

function signature(body: string): string {
  return hashToken(`${env.authSecret}|${hashToken(`${env.authSecret}|gmail-mail-state|${body}`)}`);
}

/** Consent URL plus a nonce the caller binds to the browser with a short-lived cookie. */
export function gmailAuthUrl(input: { userId: string; loginHint?: string | null }): { url: string; nonce: string } {
  const nonce = randomToken(16);
  const body = Buffer.from(JSON.stringify({ u: input.userId, n: nonce, t: Date.now() })).toString('base64url');
  const url = oauthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [GMAIL_SCOPE],
    state: `${body}.${signature(body)}`,
    ...(input.loginHint ? { login_hint: input.loginHint } : {}),
  });
  return { url, nonce };
}

export function verifyGmailState(state: string | null): { userId: string; nonce: string } | null {
  if (!state) return null;
  const dot = state.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = state.slice(0, dot);
  if (!constantTimeEquals(state.slice(dot + 1), signature(body))) return null;
  try {
    const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { u?: unknown; n?: unknown; t?: unknown };
    if (typeof decoded.u !== 'string' || typeof decoded.n !== 'string' || typeof decoded.t !== 'number') return null;
    if (Date.now() - decoded.t > STATE_TTL_MS) return null;
    return { userId: decoded.u, nonce: decoded.n };
  } catch {
    return null;
  }
}

export async function exchangeGmailCode(code: string): Promise<{ credentials: GmailCredentials; email: string }> {
  const client = oauthClient();
  let tokens: Auth.Credentials;
  try {
    tokens = (await client.getToken(code)).tokens;
  } catch (err) {
    throw new MailError('AUTH', `Google refused the sign-in: ${errorMessage(err)}`);
  }
  client.setCredentials(tokens);
  const profile = await google.gmail({ version: 'v1', auth: client }).users.getProfile({ userId: 'me' });
  const email = profile.data.emailAddress;
  if (!email) throw new MailError('UPSTREAM', 'Google did not report which mailbox was connected.');
  return {
    credentials: {
      ...(tokens.access_token ? { accessToken: tokens.access_token } : {}),
      ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
      ...(typeof tokens.expiry_date === 'number' ? { expiresAt: tokens.expiry_date } : {}),
    },
    email,
  };
}

const LABEL_SPECIAL: Record<string, SpecialFolder> = {
  INBOX: 'inbox',
  SENT: 'sent',
  DRAFT: 'drafts',
  TRASH: 'trash',
  SPAM: 'junk',
  STARRED: 'flagged',
};

const HIDDEN_LABELS = new Set(['UNREAD', 'IMPORTANT', 'CHAT', 'CATEGORY_PERSONAL', 'CATEGORY_SOCIAL', 'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS', 'YELLOW_STAR']);

/** Virtual folder for "All Mail" — Gmail has no label for it, only the absence of a filter. */
const ALL_MAIL = '__ALL__';

function mapGmailError(err: unknown): MailError {
  if (err instanceof MailError) return err;
  const status = (err as { code?: number; response?: { status?: number } }).response?.status ?? (err as { code?: number }).code;
  const message = errorMessage(err);
  if (status === 401 || /invalid_grant/i.test(message)) return new MailError('AUTH', 'Google no longer accepts this connection.', 'Sign in with Google again.');
  if (status === 404) return new MailError('NOT_FOUND', 'That message no longer exists.');
  if (status === 429) return new MailError('RATE_LIMITED', 'Gmail is rate limiting requests; try again in a minute.');
  return new MailError('UPSTREAM', message);
}

export class GmailAdapter implements MailAdapter {
  private readonly api: gmail_v1.Gmail;

  constructor(
    private readonly email: string,
    credentials: GmailCredentials,
    /** Persist rotated tokens; Google refreshes the access token transparently. */
    onTokens: (credentials: GmailCredentials) => Promise<void>,
  ) {
    const client = oauthClient();
    client.setCredentials({
      ...(credentials.accessToken ? { access_token: credentials.accessToken } : {}),
      ...(credentials.refreshToken ? { refresh_token: credentials.refreshToken } : {}),
      ...(credentials.expiresAt ? { expiry_date: credentials.expiresAt } : {}),
    });
    client.on('tokens', (tokens) => {
      void onTokens({
        ...credentials,
        ...(tokens.access_token ? { accessToken: tokens.access_token } : {}),
        ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
        ...(typeof tokens.expiry_date === 'number' ? { expiresAt: tokens.expiry_date } : {}),
      });
    });
    this.api = google.gmail({ version: 'v1', auth: client });
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      const profile = await this.api.users.getProfile({ userId: 'me' });
      return { ok: true, message: `Connected to Gmail as ${profile.data.emailAddress ?? this.email}.` };
    } catch (err) {
      throw mapGmailError(err);
    }
  }

  async listFolders(): Promise<MailFolder[]> {
    try {
      const labels = (await this.api.users.labels.list({ userId: 'me' })).data.labels ?? [];
      const visible = labels.filter((label) => label.id && !HIDDEN_LABELS.has(label.id));
      const detailed = await Promise.all(
        visible.map(async (label): Promise<MailFolder | null> => {
          const id = label.id ?? '';
          const specialUse = LABEL_SPECIAL[id] ?? null;
          if (!specialUse && label.type === 'system') return null;
          const details = specialUse === 'inbox' ? (await this.api.users.labels.get({ userId: 'me', id })).data : label;
          return {
            path: id,
            name: specialUse ? (specialUse === 'inbox' ? 'Inbox' : (label.name ?? id).charAt(0) + (label.name ?? id).slice(1).toLowerCase()) : label.name ?? id,
            specialUse,
            unread: details.messagesUnread ?? null,
            total: details.messagesTotal ?? null,
          };
        }),
      );
      const folders = detailed.filter((folder): folder is MailFolder => folder !== null);
      folders.push({ path: ALL_MAIL, name: 'All Mail', specialUse: 'all', unread: null, total: null });
      const order: Array<SpecialFolder | null> = ['inbox', 'flagged', 'sent', 'drafts', 'all', 'junk', 'trash', null];
      return folders.sort((a, b) => order.indexOf(a.specialUse) - order.indexOf(b.specialUse) || a.name.localeCompare(b.name));
    } catch (err) {
      throw mapGmailError(err);
    }
  }

  async listMessages(query: ListQuery): Promise<MailPage> {
    try {
      const list = await this.api.users.messages.list({
        userId: 'me',
        maxResults: Math.min(Math.max(1, query.pageSize ?? 50), 100),
        ...(query.folder !== ALL_MAIL ? { labelIds: [query.folder] } : {}),
        ...(query.query?.trim() ? { q: query.query.trim() } : {}),
        ...(query.cursor ? { pageToken: query.cursor } : {}),
      });
      const ids = (list.data.messages ?? []).flatMap((message) => (message.id ? [message.id] : []));
      const messages = await Promise.all(ids.map((id) => this.summary(id)));
      return { messages, total: list.data.resultSizeEstimate ?? null, nextCursor: list.data.nextPageToken ?? null };
    } catch (err) {
      throw mapGmailError(err);
    }
  }

  private async summary(id: string): Promise<MailSummary> {
    const message = (
      await this.api.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'Date'] })
    ).data;
    const header = (name: string) => message.payload?.headers?.find((entry) => entry.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
    const parseList = (value: string) =>
      value.split(',').flatMap((part) => {
        const match = part.trim().match(/^(.*?)\s*<([^>]+)>$/);
        const address = (match ? match[2] : part).trim();
        return address.includes('@') ? [{ name: match?.[1]?.replace(/^"|"$/g, '').trim() || null, address }] : [];
      });
    const labels = new Set(message.labelIds ?? []);
    return {
      id,
      threadId: message.threadId ?? null,
      from: parseList(header('From'))[0] ?? null,
      to: parseList(header('To')),
      subject: header('Subject'),
      snippet: message.snippet ?? '',
      date: message.internalDate ? new Date(Number(message.internalDate)).toISOString() : null,
      seen: !labels.has('UNREAD'),
      flagged: labels.has('STARRED'),
      hasAttachments: (message.payload?.parts ?? []).some((part) => Boolean(part.filename)),
    };
  }

  async getMessage(_folder: string, id: string, opts: { peek?: boolean } = {}) {
    try {
      const message = (await this.api.users.messages.get({ userId: 'me', id, format: 'raw' })).data;
      if (!message.raw) throw new MailError('NOT_FOUND', 'That message has no content.');
      const labels = new Set(message.labelIds ?? []);
      if (!opts.peek && labels.has('UNREAD')) {
        await this.api.users.messages.modify({ userId: 'me', id, requestBody: { removeLabelIds: ['UNREAD'] } });
        labels.delete('UNREAD');
      }
      return await parseRawMessage(Buffer.from(message.raw, 'base64url'), {
        id,
        threadId: message.threadId ?? null,
        seen: !labels.has('UNREAD'),
        flagged: labels.has('STARRED'),
      });
    } catch (err) {
      throw mapGmailError(err);
    }
  }

  async setFlags(_folder: string, ids: readonly string[], flags: { seen?: boolean; flagged?: boolean }): Promise<void> {
    if (ids.length === 0) return;
    const add: string[] = [];
    const remove: string[] = [];
    if (flags.seen === true) remove.push('UNREAD');
    if (flags.seen === false) add.push('UNREAD');
    if (flags.flagged === true) add.push('STARRED');
    if (flags.flagged === false) remove.push('STARRED');
    try {
      await this.api.users.messages.batchModify({ userId: 'me', requestBody: { ids: [...ids], addLabelIds: add, removeLabelIds: remove } });
    } catch (err) {
      throw mapGmailError(err);
    }
  }

  async move(folder: string, ids: readonly string[], target: 'archive' | 'trash' | { path: string }): Promise<void> {
    if (ids.length === 0) return;
    try {
      if (target === 'trash') {
        await Promise.all(ids.map((id) => this.api.users.messages.trash({ userId: 'me', id })));
        return;
      }
      const requestBody =
        target === 'archive'
          ? { ids: [...ids], removeLabelIds: ['INBOX'] }
          : { ids: [...ids], addLabelIds: [target.path], removeLabelIds: folder !== ALL_MAIL ? [folder] : [] };
      await this.api.users.messages.batchModify({ userId: 'me', requestBody });
    } catch (err) {
      throw mapGmailError(err);
    }
  }

  async send(message: OutgoingMessage): Promise<{ messageId: string | null }> {
    const mail = new MailComposer({
      from: formatAddress(message.from),
      to: message.to.map(formatAddress),
      cc: message.cc.map(formatAddress),
      bcc: message.bcc.map(formatAddress),
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
      ...(message.inReplyTo ? { inReplyTo: message.inReplyTo } : {}),
      ...(message.references?.length ? { references: message.references } : {}),
      attachments: (message.attachments ?? []).map((attachment) => ({ ...attachment })),
    }).compile();
    // Gmail reads Bcc from the raw message and strips it before delivery.
    mail.keepBcc = true;
    const raw = await mail.build();
    try {
      const sent = await this.api.users.messages.send({
        userId: 'me',
        requestBody: { raw: raw.toString('base64url'), ...(message.threadId ? { threadId: message.threadId } : {}) },
      });
      return { messageId: sent.data.id ?? mail.messageId() ?? null };
    } catch (err) {
      throw mapGmailError(err);
    }
  }

  async close(): Promise<void> {
    // Stateless HTTP client — nothing to release.
  }
}
