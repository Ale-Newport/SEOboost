import { GmailAdapter, type GmailCredentials } from './gmail';
import { ImapSmtpAdapter } from './imap';
import { MailError, type ImapSmtpConfig, type MailAdapter } from './types';

export * from './types';
export * from './presets';
export * from './compose';
export * from './sanitize';
export { parseRawMessage } from './parse';
export {
  GMAIL_SCOPE,
  exchangeGmailCode,
  gmailAuthUrl,
  gmailRedirectUri,
  isGmailOAuthAvailable,
  verifyGmailState,
} from './gmail';
export type { GmailCredentials } from './gmail';

export interface MailAccountSecrets {
  provider: 'IMAP_SMTP' | 'GMAIL_OAUTH';
  email: string;
  credentials: Record<string, unknown>;
  config: Record<string, unknown>;
}

function readEndpoint(value: unknown): ImapSmtpConfig['imap'] | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const host = typeof record.host === 'string' ? record.host.trim() : '';
  const port = typeof record.port === 'number' ? record.port : Number(record.port);
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65_535) return null;
  return { host, port, secure: record.secure === true || record.secure === 'true' };
}

export function readImapSmtpConfig(config: Record<string, unknown>): ImapSmtpConfig | null {
  const imap = readEndpoint(config.imap);
  const smtp = readEndpoint(config.smtp);
  if (!imap || !smtp) return null;
  return {
    imap,
    smtp,
    ...(typeof config.username === 'string' && config.username.trim() ? { username: config.username.trim() } : {}),
    ...(config.smtpSavesSent === true ? { smtpSavesSent: true } : {}),
    ...(typeof config.signature === 'string' ? { signature: config.signature } : {}),
  };
}

/** One live adapter for one request. The caller must `close()` it. */
export function createMailAdapter(
  account: MailAccountSecrets,
  onGmailTokens: (credentials: GmailCredentials) => Promise<void> = async () => {},
): MailAdapter {
  if (account.provider === 'GMAIL_OAUTH') {
    return new GmailAdapter(account.email, account.credentials as GmailCredentials, onGmailTokens);
  }
  const password = typeof account.credentials.password === 'string' ? account.credentials.password : '';
  const config = readImapSmtpConfig(account.config);
  if (!password || !config) {
    throw new MailError('NOT_CONFIGURED', 'This mailbox has no server settings or password stored.', 'Edit the account and save its password again.');
  }
  return new ImapSmtpAdapter(account.email, password, config);
}
