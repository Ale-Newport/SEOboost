import { httpRequest } from '../../adapters/http';
import { readRecord, readString } from '../../serp/http';
import { SocialSourceError, type PublishResult, type SocialAccountSecrets, type SocialPublisher } from '../types';
import { assertWithinLimit, httpFailure, requireCredential } from './shared';

/**
 * Discord publisher — a channel webhook on a server the operator runs.
 *
 * Messages are sent with mentions disabled: a generated post must never be able to ping
 * @everyone or a role, whatever text ends up in it.
 */

const LABEL = 'Discord';
const WEBHOOK_PATTERN = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;

/** The stored webhook, validated so a mistyped (or malicious) URL cannot point requests elsewhere. */
function webhook(secrets: SocialAccountSecrets): string {
  const url = requireCredential(secrets, 'webhookUrl', LABEL).replace(/\/+$/, '');
  if (!WEBHOOK_PATTERN.test(url)) {
    throw new SocialSourceError('NOT_CONFIGURED', 'That is not a Discord webhook URL (https://discord.com/api/webhooks/<id>/<token>).');
  }
  return url;
}

export const discordPublisher: SocialPublisher = {
  platform: 'DISCORD',
  label: LABEL,
  setupHelp: 'In your server: channel settings → Integrations → Webhooks → New webhook → Copy webhook URL.',
  credentialFields: [{ key: 'webhookUrl', label: 'Webhook URL', required: true, secret: true }],
  configFields: [],
  capabilities: { original: true, reply: false, title: false, metrics: false, remove: true },

  async test(secrets) {
    const res = await httpRequest(webhook(secrets));
    if (!res.ok) throw httpFailure(res, LABEL, 'webhook check');
    const info = readRecord(res.body);
    const name = readString(info?.name) || 'webhook';
    return { ok: true, handle: name, displayName: name, message: `Webhook "${name}" is valid.` };
  },

  async publish(input, secrets): Promise<PublishResult> {
    if (input.kind === 'REPLY') throw new SocialSourceError('UNSUPPORTED', 'Discord webhooks cannot reply in threads.');
    assertWithinLimit('DISCORD', input.body);
    const res = await httpRequest(`${webhook(secrets)}?wait=true`, {
      method: 'POST',
      body: { content: input.body, allowed_mentions: { parse: [] } },
    });
    if (!res.ok) throw httpFailure(res, LABEL, 'post');
    const message = readRecord(res.body);
    const id = readString(message?.id);
    if (!id) throw new SocialSourceError('UPSTREAM', 'Discord accepted the message but returned no id.');
    const guild = readString(message?.guild_id);
    const channel = readString(message?.channel_id);
    return { externalId: id, url: guild && channel ? `https://discord.com/channels/${guild}/${channel}/${id}` : null };
  },

  async remove(externalId, secrets) {
    const res = await httpRequest(`${webhook(secrets)}/messages/${encodeURIComponent(externalId)}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw httpFailure(res, LABEL, 'delete');
  },
};
