import { z } from 'zod';
import { buildResponse, type OutgoingMessage } from '@seo/integrations';
import { ValidationError, createLogger } from '@seo/shared';
import { readBody, route } from '@/lib/api';
import { assertNotReadOnly } from '@/app/api/_lib/common';
import { recipientsSchema, requireMailAccount, withMailAdapter } from '@/app/api/mail/_lib';

const log = createLogger('api:mail');

/**
 * `POST /api/mail/accounts/[id]/send` — send a new message, a reply, a reply-all or a forward.
 *
 * Every send is one explicit click in the compose form; there is no queue, schedule or bulk path.
 * Anything above ten recipients must carry `confirmedBulk` (the form asks first) — the server
 * enforces it too, so a script cannot turn the mailbox into a mass mailer by skipping the UI.
 */

const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const BULK_THRESHOLD = 10;

const bodySchema = z.object({
  mode: z.enum(['new', 'reply', 'replyAll', 'forward']),
  to: recipientsSchema,
  cc: recipientsSchema.default([]),
  bcc: recipientsSchema.default([]),
  subject: z.string().max(998).default(''),
  body: z.string().max(200_000),
  original: z.object({ folder: z.string().min(1).max(500), id: z.string().min(1).max(200) }).optional(),
  attachments: z
    .array(
      z.object({
        filename: z.string().trim().min(1).max(255),
        contentType: z.string().trim().max(200).default('application/octet-stream'),
        contentBase64: z.string(),
      }),
    )
    .max(10)
    .default([]),
  confirmedBulk: z.boolean().default(false),
});

export const POST = route<{ id: string }>(async ({ user, request, params }) => {
  const body = await readBody(request, bodySchema);
  await assertNotReadOnly();
  const account = await requireMailAccount(user.id, params.id);

  const recipients = body.to.length + body.cc.length + body.bcc.length;
  if (recipients === 0) throw new ValidationError('Add at least one recipient.');
  if (recipients > BULK_THRESHOLD && !body.confirmedBulk) {
    throw new ValidationError(`This message goes to ${recipients} people. Confirm that you mean to send it to all of them.`);
  }
  if (body.mode !== 'new' && !body.original) throw new ValidationError('Replies and forwards need the original message.');

  const attachments = body.attachments.map((attachment) => ({
    filename: attachment.filename,
    contentType: attachment.contentType,
    content: Buffer.from(attachment.contentBase64, 'base64'),
  }));
  const size = attachments.reduce((total, attachment) => total + attachment.content.length, 0);
  if (size > MAX_ATTACHMENT_BYTES) throw new ValidationError('Attachments are limited to 15 MB in total.');

  const config = typeof account.config === 'object' && account.config !== null && !Array.isArray(account.config)
    ? (account.config as Record<string, unknown>)
    : {};
  const signature = typeof config.signature === 'string' && config.signature.trim() ? `\n\n-- \n${config.signature.trim()}` : '';
  const from = { name: account.displayName, address: account.email };

  const result = await withMailAdapter(account, async (adapter) => {
    let outgoing: OutgoingMessage;
    if (body.mode === 'new') {
      outgoing = {
        from,
        to: body.to,
        cc: body.cc,
        bcc: body.bcc,
        subject: body.subject.trim() || '(no subject)',
        text: `${body.body.trim()}${signature}\n`,
      };
    } else {
      // Fetched without marking read: replying is not the same as having opened it here.
      const original = await adapter.getMessage(body.original!.folder, body.original!.id, { peek: true });
      outgoing = buildResponse({
        mode: body.mode,
        original,
        from,
        to: body.to,
        cc: body.cc,
        bcc: body.bcc,
        body: `${body.body.trim()}${signature}`,
        subject: body.subject,
      });
    }
    return adapter.send({ ...outgoing, attachments });
  });

  log.info('mail sent', { accountId: account.id, mode: body.mode, recipients, attachments: attachments.length });
  return { sent: true, messageId: result.messageId };
});
