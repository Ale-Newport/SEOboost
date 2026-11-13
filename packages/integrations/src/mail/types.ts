/**
 * Mail contracts.
 *
 * The app is a client for the operator's own mailboxes: messages are fetched live from the
 * provider on every view and never copied into our database, so a disconnected account leaves
 * nothing behind but its (encrypted) credentials. Sending is always an explicit user action.
 */

export interface MailAddress {
  name: string | null;
  address: string;
}

export type SpecialFolder = 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive' | 'all' | 'flagged';

export interface MailFolder {
  /** Provider path (IMAP mailbox path or Gmail label id); pass it back unchanged. */
  path: string;
  name: string;
  specialUse: SpecialFolder | null;
  unread: number | null;
  total: number | null;
}

export interface MailSummary {
  /** Opaque per-folder id: the IMAP UID or the Gmail message id. */
  id: string;
  threadId: string | null;
  from: MailAddress | null;
  to: MailAddress[];
  subject: string;
  snippet: string;
  date: string | null;
  seen: boolean;
  flagged: boolean;
  hasAttachments: boolean;
}

export interface MailPage {
  messages: MailSummary[];
  total: number | null;
  /** Pass back to get the next page; null on the last one. */
  nextCursor: string | null;
}

export interface MailAttachmentInfo {
  filename: string;
  contentType: string;
  size: number;
}

export interface MailMessage extends MailSummary {
  cc: MailAddress[];
  replyTo: MailAddress[];
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  text: string;
  /** Raw HTML as sent. Sanitize with `sanitizeEmailHtml` before it reaches a browser. */
  html: string | null;
  attachments: MailAttachmentInfo[];
}

export interface OutgoingAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface OutgoingMessage {
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  text: string;
  html?: string | null;
  inReplyTo?: string | null;
  references?: string[];
  /** Gmail thread to keep the reply in. Ignored by IMAP/SMTP. */
  threadId?: string | null;
  attachments?: OutgoingAttachment[];
}

export interface ListQuery {
  folder: string;
  cursor?: string | null;
  pageSize?: number;
  query?: string | null;
}

export type MailErrorCode = 'AUTH' | 'NOT_FOUND' | 'CONNECTION' | 'RATE_LIMITED' | 'BAD_INPUT' | 'UPSTREAM' | 'NOT_CONFIGURED';

/** A provider failure in one vocabulary, so the UI can say "check the app password" vs "server down". */
export class MailError extends Error {
  constructor(
    readonly code: MailErrorCode,
    message: string,
    readonly hint: string | null = null,
  ) {
    super(message);
    this.name = 'MailError';
  }
}

export interface MailAdapter {
  test(): Promise<{ ok: boolean; message: string }>;
  listFolders(): Promise<MailFolder[]>;
  listMessages(query: ListQuery): Promise<MailPage>;
  /** Fetches and parses one message; marks it read unless `peek`. */
  getMessage(folder: string, id: string, opts?: { peek?: boolean }): Promise<MailMessage>;
  setFlags(folder: string, ids: readonly string[], flags: { seen?: boolean; flagged?: boolean }): Promise<void>;
  /** `archive` and `trash` resolve to the provider's own folders. */
  move(folder: string, ids: readonly string[], target: 'archive' | 'trash' | { path: string }): Promise<void>;
  send(message: OutgoingMessage): Promise<{ messageId: string | null }>;
  close(): Promise<void>;
}

/** IMAP/SMTP endpoints, stored as the account's non-secret config. */
export interface ServerEndpoint {
  host: string;
  port: number;
  /** Implicit TLS (993/465). False means STARTTLS on a plain port (587). */
  secure: boolean;
}

export interface ImapSmtpConfig {
  imap: ServerEndpoint;
  smtp: ServerEndpoint;
  /** Login name when it differs from the address. */
  username?: string;
  /** Whether the SMTP server files its own copy in Sent (Gmail does; most do not). */
  smtpSavesSent?: boolean;
  signature?: string;
}
