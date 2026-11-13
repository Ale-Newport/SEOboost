import { z } from 'zod';
import { json, prisma } from '@seo/db';
import { createMailAdapter, detectMailPreset, isValidAddress } from '@seo/integrations';
import { ValidationError, createLogger, errorMessage, truncate } from '@seo/shared';
import { encryptJson, tryDecryptJson } from '@seo/shared/crypto';
import { readBody, route } from '@/lib/api';
import { assertNotReadOnly } from '@/app/api/_lib/common';
import { endpointSchema, makeDefault, safeMailAccount, toHttpError } from '@/app/api/mail/_lib';

const log = createLogger('api:mail');

/**
 * `POST /api/mail/accounts` — add (or update) an IMAP/SMTP mailbox.
 *
 * The password is tested against the real servers before anything is stored, unless the caller
 * opts out, so "saved" always means "works". A blank password on an existing address keeps the
 * stored one, so editing a server name does not mean pasting the app password again.
 */
const bodySchema = z.object({
  email: z.string().trim().toLowerCase().max(320),
  displayName: z.string().trim().max(200).optional(),
  password: z.string().max(500).optional(),
  imap: endpointSchema.optional(),
  smtp: endpointSchema.optional(),
  username: z.string().trim().max(320).optional(),
  signature: z.string().max(5_000).optional(),
  makeDefault: z.boolean().optional(),
  test: z.boolean().default(true),
});

export const POST = route(async ({ user, request }) => {
  const body = await readBody(request, bodySchema);
  await assertNotReadOnly();
  if (!isValidAddress(body.email)) throw new ValidationError(`"${body.email}" is not a valid email address.`);

  const existing = await prisma.mailAccount.findUnique({ where: { userId_email: { userId: user.id, email: body.email } } });
  const preset = detectMailPreset(body.email);
  const imap = body.imap ?? preset.config?.imap;
  const smtp = body.smtp ?? preset.config?.smtp;
  if (!imap || !smtp) {
    throw new ValidationError(`${preset.label}: enter the IMAP and SMTP servers for this address.`);
  }
  // App passwords are often shown with spaces ("abcd efgh ijkl mnop"); the servers want them without.
  const typed = body.password?.replace(/\s+/g, '') ?? '';
  const storedPassword = (tryDecryptJson<{ password?: string }>(existing?.credentials) ?? {}).password ?? '';
  const password = typed || storedPassword;
  if (!password) throw new ValidationError('Enter the app password for this mailbox.');

  const config = {
    imap,
    smtp,
    ...(body.username ? { username: body.username } : {}),
    ...(preset.config?.smtpSavesSent && !body.smtp ? { smtpSavesSent: true } : {}),
    ...(body.signature !== undefined ? { signature: body.signature } : {}),
  };

  let status: 'CONNECTED' | 'ERROR' | 'NOT_CONFIGURED' = 'NOT_CONFIGURED';
  let lastError: string | null = null;
  let message = 'Saved without testing.';
  if (body.test) {
    const adapter = createMailAdapter({ provider: 'IMAP_SMTP', email: body.email, credentials: { password }, config });
    try {
      message = (await adapter.test()).message;
      status = 'CONNECTED';
    } catch (err) {
      // Nothing is stored for a brand-new address that does not work: the form shows why.
      if (!existing) throw toHttpError(err);
      status = 'ERROR';
      lastError = truncate(errorMessage(err), 1_000);
      message = lastError;
    } finally {
      await adapter.close().catch(() => undefined);
    }
  }

  const count = await prisma.mailAccount.count({ where: { userId: user.id } });
  const data = {
    provider: 'IMAP_SMTP' as const,
    displayName: body.displayName ?? existing?.displayName ?? null,
    credentials: encryptJson({ password }),
    config: json(config),
    status,
    lastError,
    ...(status === 'CONNECTED' ? { lastSyncAt: new Date() } : {}),
  };
  const account = await prisma.mailAccount.upsert({
    where: { userId_email: { userId: user.id, email: body.email } },
    create: { userId: user.id, email: body.email, isDefault: count === 0, ...data },
    update: data,
  });
  if (body.makeDefault) await makeDefault(user.id, account.id);
  log.info('mail account saved', { accountId: account.id, status, tested: body.test });

  const fresh = await prisma.mailAccount.findUniqueOrThrow({ where: { id: account.id } });
  return { account: safeMailAccount(fresh), message };
});
