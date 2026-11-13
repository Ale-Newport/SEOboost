import 'server-only';
import { z } from 'zod';
import { type MailAccount, prisma } from '@seo/db';
import {
  MailError,
  createMailAdapter,
  isValidAddress,
  type MailAdapter,
} from '@seo/integrations';
import { AppError, NotFoundError, ValidationError, createLogger, errorMessage, truncate } from '@seo/shared';
import { encryptJson, tryDecryptJson } from '@seo/shared/crypto';

/**
 * Shared plumbing for the mail routes: ownership, credential decryption and the one-connection-
 * per-request lifecycle. Every route that talks to a mailbox goes through `withMailAdapter`, so
 * an IMAP socket can never be left open and a refused login always lands on the account row.
 */

const log = createLogger('api:mail');

/** Binds the Gmail consent round-trip to this browser; compared with the signed state on return. */
export const GMAIL_NONCE_COOKIE = 'seo_os_gmail_nonce';

export async function requireMailAccount(userId: string, accountId: string): Promise<MailAccount> {
  const account = await prisma.mailAccount.findFirst({ where: { id: accountId, userId } });
  if (!account) throw new NotFoundError('Mail account');
  return account;
}

function configOf(account: MailAccount): Record<string, unknown> {
  return typeof account.config === 'object' && account.config !== null && !Array.isArray(account.config)
    ? (account.config as Record<string, unknown>)
    : {};
}

/** Map provider failures onto HTTP errors the client already knows how to show. */
export function toHttpError(err: unknown): unknown {
  if (!(err instanceof MailError)) return err;
  const status = { AUTH: 401, NOT_FOUND: 404, CONNECTION: 502, RATE_LIMITED: 429, BAD_INPUT: 400, UPSTREAM: 502, NOT_CONFIGURED: 409 }[err.code];
  // 401 would bounce the operator to the login page; a refused *mailbox* login is a 422 here.
  return new AppError(err.hint ? `${err.message} ${err.hint}` : err.message, {
    code: `MAIL_${err.code}`,
    status: status === 401 ? 422 : status,
    retryable: err.code === 'CONNECTION' || err.code === 'RATE_LIMITED',
  });
}

export async function withMailAdapter<T>(account: MailAccount, fn: (adapter: MailAdapter) => Promise<T>): Promise<T> {
  const credentials = tryDecryptJson<Record<string, unknown>>(account.credentials) ?? {};
  let adapter: MailAdapter;
  try {
    adapter = createMailAdapter(
      { provider: account.provider, email: account.email, credentials, config: configOf(account) },
      async (fresh) => {
        await prisma.mailAccount.update({
          where: { id: account.id },
          data: { credentials: encryptJson({ ...credentials, ...fresh }) },
        });
      },
    );
  } catch (err) {
    throw toHttpError(err);
  }
  try {
    const value = await fn(adapter);
    if (account.status !== 'CONNECTED' || account.lastError) {
      await prisma.mailAccount.update({ where: { id: account.id }, data: { status: 'CONNECTED', lastError: null, lastSyncAt: new Date() } });
    }
    return value;
  } catch (err) {
    if (err instanceof MailError && (err.code === 'AUTH' || err.code === 'NOT_CONFIGURED')) {
      await prisma.mailAccount.update({
        where: { id: account.id },
        data: { status: err.code === 'AUTH' ? 'ERROR' : 'NOT_CONFIGURED', lastError: truncate(err.message, 1_000) },
      });
    }
    log.info('mail operation failed', { accountId: account.id, error: errorMessage(err) });
    throw toHttpError(err);
  } finally {
    await adapter.close().catch(() => undefined);
  }
}

/** Accounts as the browser may see them: no credentials, ever. */
export function safeMailAccount(account: MailAccount) {
  const config = configOf(account);
  return {
    id: account.id,
    email: account.email,
    displayName: account.displayName,
    provider: account.provider,
    status: account.status,
    isDefault: account.isDefault,
    lastSyncAt: account.lastSyncAt?.toISOString() ?? null,
    lastError: account.lastError,
    hasPassword: Boolean(account.credentials),
    signature: typeof config.signature === 'string' ? config.signature : '',
    imapHost: typeof config.imap === 'object' && config.imap ? String((config.imap as Record<string, unknown>).host ?? '') : '',
  };
}

export const endpointSchema = z.object({
  host: z.string().trim().min(3).max(255),
  port: z.coerce.number().int().min(1).max(65_535),
  secure: z.boolean(),
});

/** A recipient list as the compose form sends it: already-split addresses. */
export const recipientsSchema = z
  .array(z.object({ name: z.string().max(200).nullable().optional(), address: z.string().trim().max(320) }))
  .max(100)
  .transform((list, ctx) => {
    for (const entry of list) {
      if (!isValidAddress(entry.address)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `"${entry.address}" is not a valid email address.` });
      }
    }
    return list.map((entry) => ({ name: entry.name?.trim() || null, address: entry.address }));
  });

/** At most one default account per user. */
export async function makeDefault(userId: string, accountId: string): Promise<void> {
  await prisma.$transaction([
    prisma.mailAccount.updateMany({ where: { userId, isDefault: true, NOT: { id: accountId } }, data: { isDefault: false } }),
    prisma.mailAccount.update({ where: { id: accountId }, data: { isDefault: true } }),
  ]);
}

export function assertFolder(folder: string | undefined): string {
  if (!folder || folder.length > 500) throw new ValidationError('A folder is required.');
  return folder;
}

