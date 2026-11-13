/**
 * Client-side mirrors of the mail API responses. Kept local so client components never import a
 * server-only package; the shapes match `@seo/integrations` mail types and `safeMailAccount`.
 */

export interface MailAccountView {
  id: string;
  email: string;
  displayName: string | null;
  provider: 'IMAP_SMTP' | 'GMAIL_OAUTH';
  status: 'NOT_CONFIGURED' | 'CONNECTED' | 'ERROR' | 'EXPIRED' | 'DISABLED';
  isDefault: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  hasPassword: boolean;
  signature: string;
  imapHost: string;
}

export interface MailPresetView {
  id: string;
  label: string;
  domains: readonly string[];
  appPasswordUrl: string | null;
  steps: readonly string[];
}

export interface MailOverviewView {
  accounts: MailAccountView[];
  gmailOAuthAvailable: boolean;
  presets: MailPresetView[];
}

export interface MailAddressView {
  name: string | null;
  address: string;
}

export type SpecialFolderView = 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive' | 'all' | 'flagged';

export interface MailFolderView {
  path: string;
  name: string;
  specialUse: SpecialFolderView | null;
  unread: number | null;
  total: number | null;
}

export interface MailSummaryView {
  id: string;
  threadId: string | null;
  from: MailAddressView | null;
  to: MailAddressView[];
  subject: string;
  snippet: string;
  date: string | null;
  seen: boolean;
  flagged: boolean;
  hasAttachments: boolean;
}

export interface MailPageView {
  messages: MailSummaryView[];
  total: number | null;
  nextCursor: string | null;
}

export interface MailMessageView extends MailSummaryView {
  cc: MailAddressView[];
  replyTo: MailAddressView[];
  messageId: string | null;
  text: string;
  /** Already sanitized on the server. */
  html: string | null;
  attachments: Array<{ filename: string; contentType: string; size: number }>;
}

export type ComposeMode = 'new' | 'reply' | 'replyAll' | 'forward';

export interface ComposeTarget {
  mode: ComposeMode;
  /** The message being answered or forwarded, with its folder. */
  original?: { folder: string; message: MailMessageView };
}

export function formatAddressView(address: MailAddressView): string {
  return address.name ? `${address.name} <${address.address}>` : address.address;
}

export function displayName(address: MailAddressView | null): string {
  if (!address) return '(unknown sender)';
  return address.name || address.address;
}
