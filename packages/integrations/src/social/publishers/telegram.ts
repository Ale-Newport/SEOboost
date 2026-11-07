import { httpRequest, type HttpResult } from '../../adapters/http';
import { readNumber, readRecord, readString } from '../../serp/http';
import { SocialSourceError, type PublishResult, type SocialAccountSecrets, type SocialPublisher } from '../types';
import { assertWithinLimit, configString, httpFailure, requireCredential } from './shared';

/**
 * Telegram publisher — a bot posting to a channel the operator owns.
 *
 * The bot must be an administrator of the channel with "Post messages". The Bot API puts the
 * token in the URL path by design; it is only ever logged by the HTTP layer at debug level.
 */

const LABEL = 'Telegram';

function chatId(secrets: SocialAccountSecrets): string {
  const id = configString(secrets, 'chatId');
  if (!id) throw new SocialSourceError('NOT_CONFIGURED', 'Telegram needs the channel (@channelname or numeric chat id).');
  return id;
}

/** Telegram reports its own retry delay in `parameters.retry_after`; prefer it over headers. */
function failure(res: HttpResult, operation: string): SocialSourceError {
  const error = httpFailure(res, LABEL, operation);
  const retry = readNumber(readRecord(readRecord(res.body)?.parameters)?.retry_after, Number.NaN);
  if (error.code === 'RATE_LIMITED' && Number.isFinite(retry)) {
    return new SocialSourceError('RATE_LIMITED', error.message, null, Math.ceil(retry));
  }
  return error;
}

async function call(secrets: SocialAccountSecrets, method: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const token = requireCredential(secrets, 'botToken', LABEL);
  const res = await httpRequest(`https://api.telegram.org/bot${token}/${method}`, {
    method: body ? 'POST' : 'GET',
    ...(body ? { body } : {}),
  });
  const payload = readRecord(res.body);
  if (!res.ok || payload?.ok !== true) throw failure(res, method);
  return readRecord(payload.result) ?? {};
}

export const telegramPublisher: SocialPublisher = {
  platform: 'TELEGRAM',
  label: LABEL,
  setupHelp:
    'Create a bot with @BotFather, add it to your channel as an administrator allowed to post, and enter the channel as @channelname (or its numeric id).',
  credentialFields: [{ key: 'botToken', label: 'Bot token', required: true, secret: true, placeholder: '123456:ABC-DEF…' }],
  configFields: [{ key: 'chatId', label: 'Channel', required: true, secret: false, placeholder: '@yourchannel' }],
  capabilities: { original: true, reply: false, title: false, metrics: false, remove: true },

  async test(secrets) {
    const bot = await call(secrets, 'getMe');
    const chat = await call(secrets, 'getChat', { chat_id: chatId(secrets) });
    const title = readString(chat.title) || readString(chat.username) || chatId(secrets);
    return {
      ok: true,
      handle: chatId(secrets),
      displayName: title,
      message: `Bot @${readString(bot.username)} can see ${title}. Make sure it is an administrator with permission to post.`,
    };
  },

  async publish(input, secrets): Promise<PublishResult> {
    if (input.kind === 'REPLY') throw new SocialSourceError('UNSUPPORTED', 'Telegram channels have no threads to reply in.');
    assertWithinLimit('TELEGRAM', input.body);
    const target = chatId(secrets);
    const message = await call(secrets, 'sendMessage', { chat_id: target, text: input.body, disable_web_page_preview: false });
    const id = readString(message.message_id);
    if (!id) throw new SocialSourceError('UPSTREAM', 'Telegram accepted the message but returned no id.');
    const username = readString(readRecord(message.chat)?.username) || (target.startsWith('@') ? target.slice(1) : '');
    return { externalId: id, url: username ? `https://t.me/${username}/${id}` : null };
  },

  async remove(externalId, secrets) {
    await call(secrets, 'deleteMessage', { chat_id: chatId(secrets), message_id: Number(externalId) });
  },
};
