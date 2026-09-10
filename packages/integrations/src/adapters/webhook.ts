import { createHmac } from 'node:crypto';
import { createLogger } from '@seo/shared';
import { constantTimeEquals, randomToken } from '@seo/shared/crypto';
import {
  codeForStatus,
  failFromThrown,
  httpRequest,
  isRecord,
  providerMessage,
  readBoolean,
  readNumber,
  readString,
  toJsonValue,
  type HttpResult,
} from './http';
import {
  adapterFail,
  adapterOk,
  unsupported,
  type AdapterCapabilities,
  type AdapterFieldSpec,
  type AdapterResult,
  type AdapterResultMeta,
  type AdapterSiteContext,
  type ConnectionInfo,
  type ContentPatch,
  type ContentPayload,
  type ContentRef,
  type JsonObject,
  type JsonValue,
  type ListContentOptions,
  type MetadataPatch,
  type MetadataWriteResult,
  type RedirectType,
  type RedirectWriteResult,
  type RemoteContent,
  type RemoteContentPage,
  type StructuredDataWriteResult,
  type WebsiteAdapter,
} from './types';

/**
 * Generic outbound webhook adapter — the escape hatch for platforms this repo has no
 * first-party adapter for (custom CMSes, headless stacks, in-house publishing pipelines).
 *
 * SEO OS POSTs a signed JSON envelope describing the change it wants made; the customer's
 * endpoint decides how to apply it. The adapter is therefore **write-only and one-way**:
 * it cannot read the site back, so `capabilities.readContent` is false, every result
 * carries `beforeState: null`, and the UI disables one-click rollback for these changes.
 * That is honest; pretending otherwise would put a fabricated snapshot into ChangeLog.
 *
 * ## Payload schema (the contract a receiver implements)
 *
 * ```jsonc
 * {
 *   "version": 1,                       // bumped only on a breaking envelope change
 *   "id": "y1Qk…",                      // unique per delivery; use it to dedupe retries
 *   "sentAt": "2026-09-09T10:11:12.000Z",
 *   "operation": "updateContent",       // see WebhookOperation below
 *   "site": {
 *     "websiteId": "clx…",              // SEO OS id, stable for the life of the site
 *     "domain": "example.com",
 *     "url": "https://example.com"
 *   },
 *   "externalId": "post:123",           // the receiver's own content id; absent on create
 *   "data": { … }                       // operation-specific, see below
 * }
 * ```
 *
 * `data` by operation:
 * - `testConnection`  — `{}`. Reply 2xx to confirm the endpoint is live.
 * - `createContent`   — `{ title, slug?, bodyHtml?, bodyMarkdown?, excerpt?, metaTitle?,
 *                          metaDescription?, status?, container?, structuredData? }`
 * - `updateContent`   — same keys as createContent, all optional (a patch).
 * - `publishContent`  — `{}` (the target is `externalId`).
 * - `updateMetadata`  — `{ metaTitle?, metaDescription?, canonicalUrl?, noindex? }`
 * - `structuredData`  — `{ jsonLd: <JSON-LD object or array> }`
 * - `createRedirect`  — `{ from, to, type }` where type is 301 | 302 | 307 | 308
 *
 * ## Signature
 *
 * Headers on every request:
 * - `X-SEO-OS-Timestamp: <unix seconds>`
 * - `X-SEO-OS-Signature: sha256=<hex>` where hex is
 *   `HMAC-SHA256(secret, "<timestamp>.<raw request body>")`
 *
 * Verify with the exact raw body bytes — re-serialising the parsed JSON changes key order
 * and whitespace and will not match. `verifyWebhookSignature` below is the reference
 * implementation; it is exported so a receiver written in this repo (or a customer reading
 * this file) has one canonical version to copy.
 *
 * ## Response
 *
 * A 2xx means *accepted*. To let SEO OS record what was actually created, reply with JSON:
 * `{ "ok": true, "id": "<content id>", "url": "https://…" }`. Reply `{ "ok": false,
 * "error": "…" }` (or a non-2xx) to have the change recorded as failed. Anything else is
 * treated as "accepted, outcome unknown" and produces a warning rather than an invented id.
 */

const log = createLogger('adapters:webhook');

export const WEBHOOK_PAYLOAD_VERSION = 1;

export const WEBHOOK_SIGNATURE_HEADER = 'x-seo-os-signature';
export const WEBHOOK_TIMESTAMP_HEADER = 'x-seo-os-timestamp';
export const WEBHOOK_DELIVERY_HEADER = 'x-seo-os-delivery';
export const WEBHOOK_SIGNATURE_PREFIX = 'sha256=';

/** Default replay window. Wide enough for clock skew, narrow enough to bound a replay. */
export const WEBHOOK_DEFAULT_TOLERANCE_SECONDS = 300;

export type WebhookOperation =
  | 'testConnection'
  | 'createContent'
  | 'updateContent'
  | 'publishContent'
  | 'updateMetadata'
  | 'structuredData'
  | 'createRedirect';

export interface WebhookCredentials {
  /** Shared HMAC secret. Without it the adapter refuses to send — an unsigned change is unverifiable. */
  secret: string;
}

export interface WebhookConfig {
  /** Absolute https:// endpoint that receives the envelope. */
  url: string;
  /** Extra static headers (a gateway token, a tenant id). Never used for the signature. */
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export const WEBHOOK_CAPABILITIES: AdapterCapabilities = {
  // One-way: we can describe a change, never read the site back.
  readContent: false,
  updateContent: true,
  createContent: true,
  publish: true,
  updateMetadata: true,
  injectStructuredData: true,
  createRedirect: true,
  updateSitemap: false,
};

export const WEBHOOK_CREDENTIAL_FIELDS: AdapterFieldSpec[] = [
  {
    key: 'secret',
    label: 'Signing secret',
    required: true,
    secret: true,
    help: 'Shared secret used to HMAC-SHA256 every delivery. Store the same value on your endpoint and verify the X-SEO-OS-Signature header.',
  },
];

export const WEBHOOK_CONFIG_FIELDS: AdapterFieldSpec[] = [
  {
    key: 'url',
    label: 'Endpoint URL',
    required: true,
    secret: false,
    placeholder: 'https://example.com/api/seo-os/webhook',
    help: 'Must be https. Receives a signed JSON POST for every approved change.',
  },
];

// ── signing / verification ────────────────────────────────────────────────────

export interface WebhookSignatureInput {
  /** The exact serialised request body. */
  body: string;
  secret: string;
  /** Unix seconds. Defaults to now. */
  timestamp?: number;
}

export interface WebhookSignature {
  /** Value for the `X-SEO-OS-Signature` header, including the `sha256=` prefix. */
  signature: string;
  /** Value for the `X-SEO-OS-Timestamp` header (unix seconds, as a string). */
  timestamp: string;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** `HMAC-SHA256(secret, "<timestamp>.<body>")`, hex. Timestamp is inside the MAC so it cannot be rewritten. */
export function computeWebhookSignature(input: WebhookSignatureInput): WebhookSignature {
  const timestamp = String(input.timestamp ?? nowSeconds());
  const digest = createHmac('sha256', input.secret).update(`${timestamp}.${input.body}`, 'utf8').digest('hex');
  return { signature: `${WEBHOOK_SIGNATURE_PREFIX}${digest}`, timestamp };
}

export type WebhookVerificationFailure =
  | 'MISSING_SECRET'
  | 'MISSING_SIGNATURE'
  | 'MISSING_TIMESTAMP'
  | 'MALFORMED_TIMESTAMP'
  | 'TIMESTAMP_OUT_OF_TOLERANCE'
  | 'SIGNATURE_MISMATCH';

export type WebhookVerification =
  | { valid: true }
  | { valid: false; reason: WebhookVerificationFailure; message: string };

export interface VerifyWebhookSignatureInput {
  /** The raw request body exactly as received — not a re-serialised object. */
  body: string;
  /** `X-SEO-OS-Timestamp`. Accepts the header string or the number. */
  timestamp: string | number | null | undefined;
  /** `X-SEO-OS-Signature`. The `sha256=` prefix is optional. */
  signature: string | null | undefined;
  secret: string;
  /** Replay window in seconds either side of now. Defaults to 300. */
  toleranceSeconds?: number;
  /** Injectable clock (unix seconds) so the check is testable without faking timers. */
  nowSeconds?: number;
}

/**
 * Reference verification for the receiving side.
 *
 * Two properties matter and are easy to get wrong:
 *  - the comparison is constant-time, so a mismatching signature leaks no timing signal
 *    an attacker could use to forge one byte at a time;
 *  - the timestamp is checked against a tolerance, so a captured-and-replayed request
 *    stops being accepted once the window passes. Skipping this makes a valid signature
 *    replayable forever.
 */
export function verifyWebhookSignature(input: VerifyWebhookSignatureInput): WebhookVerification {
  if (!input.secret) {
    return { valid: false, reason: 'MISSING_SECRET', message: 'No signing secret was supplied.' };
  }
  if (!input.signature) {
    return {
      valid: false,
      reason: 'MISSING_SIGNATURE',
      message: `Missing the ${WEBHOOK_SIGNATURE_HEADER} header.`,
    };
  }
  if (input.timestamp === null || input.timestamp === undefined || input.timestamp === '') {
    return {
      valid: false,
      reason: 'MISSING_TIMESTAMP',
      message: `Missing the ${WEBHOOK_TIMESTAMP_HEADER} header.`,
    };
  }

  const timestamp = Number(input.timestamp);
  if (!Number.isFinite(timestamp) || !Number.isInteger(timestamp)) {
    return {
      valid: false,
      reason: 'MALFORMED_TIMESTAMP',
      message: `${WEBHOOK_TIMESTAMP_HEADER} must be an integer number of seconds since the epoch.`,
    };
  }

  const tolerance = input.toleranceSeconds ?? WEBHOOK_DEFAULT_TOLERANCE_SECONDS;
  const current = input.nowSeconds ?? nowSeconds();
  if (Math.abs(current - timestamp) > tolerance) {
    return {
      valid: false,
      reason: 'TIMESTAMP_OUT_OF_TOLERANCE',
      message: `Timestamp is ${Math.abs(current - timestamp)}s away from now, outside the ${tolerance}s replay window.`,
    };
  }

  // Sign with the timestamp the caller sent: a rewritten timestamp changes the MAC input
  // and therefore fails the compare below.
  const expected = computeWebhookSignature({ body: input.body, secret: input.secret, timestamp });
  const provided = input.signature.startsWith(WEBHOOK_SIGNATURE_PREFIX)
    ? input.signature
    : `${WEBHOOK_SIGNATURE_PREFIX}${input.signature}`;

  if (!constantTimeEquals(expected.signature, provided)) {
    return {
      valid: false,
      reason: 'SIGNATURE_MISMATCH',
      message: 'Signature does not match the body. Verify against the raw request bytes, not a re-serialised object.',
    };
  }
  return { valid: true };
}

// ── envelope ──────────────────────────────────────────────────────────────────

export interface WebhookEnvelope extends JsonObject {
  version: number;
  id: string;
  sentAt: string;
  operation: WebhookOperation;
  site: JsonObject;
  data: JsonObject;
}

/** What the receiver told us it did. Everything is optional — we never invent an id or a url. */
interface WebhookAck {
  ok: boolean;
  id?: string;
  url?: string;
  error?: string;
  /** True when the endpoint answered 2xx but said nothing machine-readable. */
  opaque: boolean;
}

export class WebhookAdapter implements WebsiteAdapter {
  readonly name = 'webhook';
  readonly capabilities = WEBHOOK_CAPABILITIES;

  private readonly url: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly credentials: WebhookCredentials,
    private readonly config: WebhookConfig,
    private readonly site: AdapterSiteContext,
  ) {
    // Deliberately not normalised beyond trimming whitespace: some endpoints require the
    // trailing slash, and a redirect would turn our signed POST into a GET.
    this.url = config.url.trim();
    this.timeoutMs = config.timeoutMs ?? 20_000;
  }

  // ── delivery ────────────────────────────────────────────────────────────────

  private buildEnvelope(operation: WebhookOperation, data: JsonObject, externalId?: string): WebhookEnvelope {
    const envelope: WebhookEnvelope = {
      version: WEBHOOK_PAYLOAD_VERSION,
      id: randomToken(12),
      sentAt: new Date().toISOString(),
      operation,
      site: {
        websiteId: this.site.websiteId,
        domain: this.site.domain,
        url: this.site.siteUrl,
      },
      data,
    };
    if (externalId !== undefined) envelope.externalId = externalId;
    return envelope;
  }

  /**
   * Every delivery must be https, not just the one `testConnection` makes: the envelope
   * carries unpublished copy and a signature an eavesdropper could replay inside the
   * tolerance window, and `applyChange` reaches `deliver` without ever calling
   * `testConnection` first.
   */
  private requireSecureEndpoint<T>(): AdapterResult<T> | null {
    if (/^https:\/\//i.test(this.url)) return null;
    return adapterFail<T>(
      'VALIDATION',
      `The webhook URL must be https (got "${this.url || 'an empty URL'}"). Signed payloads describe unpublished content and must not travel in the clear.`,
      { beforeState: null },
    );
  }

  private async deliver(
    operation: WebhookOperation,
    data: JsonObject,
    externalId?: string,
  ): Promise<AdapterResult<WebhookAck>> {
    const insecure = this.requireSecureEndpoint<WebhookAck>();
    if (insecure) return insecure;

    const envelope = this.buildEnvelope(operation, data, externalId);
    // Serialise once and sign these exact bytes — httpRequest sends `rawBody` verbatim.
    const body = JSON.stringify(envelope);
    const { signature, timestamp } = computeWebhookSignature({ body, secret: this.credentials.secret });

    try {
      const res = await httpRequest(this.url, {
        method: 'POST',
        rawBody: body,
        timeoutMs: this.timeoutMs,
        headers: {
          ...this.config.headers,
          'content-type': 'application/json',
          [WEBHOOK_SIGNATURE_HEADER]: signature,
          [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
          [WEBHOOK_DELIVERY_HEADER]: envelope.id,
          'user-agent': 'seo-os-webhook/1',
        },
      });

      if (!res.ok) return this.failFrom<WebhookAck>(operation, res);

      const ack = readAck(res);
      if (!ack.ok) {
        return adapterFail<WebhookAck>(
          'PROVIDER_ERROR',
          `The webhook endpoint accepted the request but reported a failure: ${ack.error ?? 'no reason given'}.`,
          { beforeState: null },
        );
      }
      log.debug('webhook delivered', { operation, deliveryId: envelope.id, status: res.status });
      return adapterOk(ack, { beforeState: null, externalId: ack.id ?? externalId, url: ack.url });
    } catch (err) {
      return failFromThrown<WebhookAck>('Webhook', operation, err);
    }
  }

  private failFrom<T>(operation: string, res: HttpResult, meta: AdapterResultMeta = {}): AdapterResult<T> {
    const detail = providerMessage(res);
    let message: string;
    switch (res.status) {
      case 401:
      case 403:
        message =
          `The webhook endpoint rejected the ${operation} delivery as unauthorised. Confirm the signing secret stored here ` +
          'matches the one your endpoint verifies against, and that it hashes `"<timestamp>.<raw body>"`, not the body alone.';
        break;
      case 404:
        message = `The webhook endpoint returned 404 for ${this.url}. Check the URL configured on this integration.`;
        break;
      case 410:
        message = `The webhook endpoint reported ${this.url} is gone. Update or disconnect the integration.`;
        break;
      case 429:
        message = 'The webhook endpoint is rate-limiting deliveries. The change was not applied; retry shortly.';
        break;
      default:
        message = `The webhook endpoint returned HTTP ${res.status} for the ${operation} delivery.`;
        break;
    }
    return adapterFail<T>(codeForStatus(res.status), detail ? `${message} (${detail})` : message, {
      beforeState: null,
      ...meta,
    });
  }

  /** Turn a delivery ack into a ContentRef, keeping "we do not know the id" visible. */
  private toRef(
    ack: AdapterResult<WebhookAck>,
    fallbackId: string,
    operation: string,
  ): AdapterResult<ContentRef> {
    if (!ack.ok) return adapterFail<ContentRef>(ack.errorCode, ack.error, { beforeState: null });
    const warnings = [
      'Delivered to the webhook endpoint. SEO OS cannot read this site back, so the change is recorded as sent, not verified, and cannot be rolled back automatically.',
    ];
    if (ack.data.opaque) {
      warnings.push(
        `The endpoint returned 2xx without a JSON body, so the ${operation} result could not be confirmed. Reply with {"ok":true,"id":"…","url":"…"} to record the real target.`,
      );
    }
    return adapterOk<ContentRef>(
      { id: ack.data.id ?? fallbackId, url: ack.data.url },
      { beforeState: null, externalId: ack.data.id ?? fallbackId, url: ack.data.url, warnings },
    );
  }

  // ── read (not possible over a one-way webhook) ──────────────────────────────

  async testConnection(): Promise<AdapterResult<ConnectionInfo>> {
    const insecure = this.requireSecureEndpoint<ConnectionInfo>();
    if (insecure) return insecure;

    const ack = await this.deliver('testConnection', {});
    if (!ack.ok) return adapterFail<ConnectionInfo>(ack.errorCode, ack.error, { beforeState: null });
    return adapterOk<ConnectionInfo>(
      {
        detail: `Webhook endpoint ${this.url} accepted a signed test delivery.`,
        meta: { url: this.url, payloadVersion: WEBHOOK_PAYLOAD_VERSION },
      },
      {
        warnings: [
          'This adapter is write-only: it can send changes but cannot read the site, so before/after snapshots and automatic rollback are unavailable.',
        ],
      },
    );
  }

  async listContent(_opts?: ListContentOptions): Promise<AdapterResult<RemoteContentPage>> {
    return unsupported(
      'webhook',
      'listContent',
      'A webhook is one-way. Connect WordPress, Shopify, Webflow or a git repository if you need SEO OS to browse existing content.',
    );
  }

  async getContent(_externalId: string): Promise<AdapterResult<RemoteContent>> {
    return unsupported(
      'webhook',
      'getContent',
      'A webhook is one-way, so the current state of a page cannot be read back. Changes sent this way are recorded without a before-snapshot.',
    );
  }

  // ── write ───────────────────────────────────────────────────────────────────

  async createContent(payload: ContentPayload): Promise<AdapterResult<ContentRef>> {
    const data = contentPayloadToJson(payload);
    const ack = await this.deliver('createContent', data);
    // No id existed before the call, so there is no sensible fallback: an endpoint that
    // does not return one gets an empty ref plus the warning from toRef().
    return this.toRef(ack, '', 'create');
  }

  async updateContent(externalId: string, patch: ContentPatch): Promise<AdapterResult<ContentRef>> {
    if (!externalId) {
      return adapterFail<ContentRef>('VALIDATION', 'An externalId is required so the endpoint knows which page to update.');
    }
    const ack = await this.deliver('updateContent', contentPayloadToJson(patch), externalId);
    return this.toRef(ack, externalId, 'update');
  }

  async publishContent(externalId: string): Promise<AdapterResult<ContentRef>> {
    if (!externalId) {
      return adapterFail<ContentRef>('VALIDATION', 'An externalId is required so the endpoint knows what to publish.');
    }
    const ack = await this.deliver('publishContent', {}, externalId);
    return this.toRef(ack, externalId, 'publish');
  }

  async updateMetadata(externalId: string, patch: MetadataPatch): Promise<AdapterResult<MetadataWriteResult>> {
    if (!externalId) {
      return adapterFail<MetadataWriteResult>('VALIDATION', 'An externalId is required to target the metadata write.');
    }
    const data: JsonObject = {};
    const fields: string[] = [];
    if (patch.metaTitle !== undefined) {
      data.metaTitle = patch.metaTitle;
      fields.push('metaTitle');
    }
    if (patch.metaDescription !== undefined) {
      data.metaDescription = patch.metaDescription;
      fields.push('metaDescription');
    }
    if (patch.canonicalUrl !== undefined) {
      data.canonicalUrl = patch.canonicalUrl;
      fields.push('canonicalUrl');
    }
    if (patch.noindex !== undefined) {
      data.noindex = patch.noindex;
      fields.push('noindex');
    }
    if (!fields.length) {
      return adapterFail<MetadataWriteResult>('VALIDATION', 'No metadata fields were supplied.', { beforeState: null });
    }

    const ack = await this.deliver('updateMetadata', data, externalId);
    if (!ack.ok) return adapterFail<MetadataWriteResult>(ack.errorCode, ack.error, { beforeState: null });

    // `fieldsWritten` is what we *sent*; the endpoint owns whether it stored them, so the
    // warning below keeps that distinction in the audit trail rather than claiming success.
    const warnings = [
      'Metadata was delivered to the webhook endpoint. SEO OS cannot verify it was stored, because a webhook site cannot be read back.',
    ];
    if (ack.data.opaque) {
      warnings.push('The endpoint returned no JSON body, so nothing confirmed which fields it applied.');
    }
    return adapterOk<MetadataWriteResult>(
      { fieldsWritten: fields, via: 'webhook' },
      { beforeState: null, externalId: ack.data.id ?? externalId, url: ack.data.url, warnings },
    );
  }

  async injectStructuredData(externalId: string, jsonLd: JsonValue): Promise<AdapterResult<StructuredDataWriteResult>> {
    if (!externalId) {
      return adapterFail<StructuredDataWriteResult>('VALIDATION', 'An externalId is required to target the structured data write.');
    }
    if (jsonLd === null || jsonLd === undefined) {
      return adapterFail<StructuredDataWriteResult>('VALIDATION', 'The JSON-LD payload is empty.', { beforeState: null });
    }
    const ack = await this.deliver('structuredData', { jsonLd }, externalId);
    if (!ack.ok) return adapterFail<StructuredDataWriteResult>(ack.errorCode, ack.error, { beforeState: null });
    return adapterOk<StructuredDataWriteResult>(
      { applied: true, via: 'webhook' },
      {
        beforeState: null,
        externalId: ack.data.id ?? externalId,
        url: ack.data.url,
        warnings: ['Delivered to the webhook endpoint; rendering of the JSON-LD is the receiver\'s responsibility.'],
      },
    );
  }

  async createRedirect(from: string, to: string, type: RedirectType = 301): Promise<AdapterResult<RedirectWriteResult>> {
    if (!from || !to) {
      return adapterFail<RedirectWriteResult>('VALIDATION', 'Both `from` and `to` are required for a redirect.', {
        beforeState: null,
      });
    }
    const ack = await this.deliver('createRedirect', { from, to, type });
    if (!ack.ok) return adapterFail<RedirectWriteResult>(ack.errorCode, ack.error, { beforeState: null });
    return adapterOk<RedirectWriteResult>(
      { from, to, type, via: 'webhook' },
      {
        beforeState: null,
        url: ack.data.url,
        warnings: ['The redirect was delivered to the webhook endpoint; SEO OS cannot confirm it is live.'],
      },
    );
  }

  async updateSitemap(): Promise<AdapterResult<{ submitted: boolean; via: string }>> {
    return unsupported(
      'webhook',
      'updateSitemap',
      'Submit sitemaps through Search Console or Bing Webmaster Tools instead.',
    );
  }
}

export function createWebhookAdapter(input: {
  credentials: WebhookCredentials;
  config: WebhookConfig;
  site: AdapterSiteContext;
}): WebhookAdapter {
  return new WebhookAdapter(input.credentials, input.config, input.site);
}

export function parseWebhookCredentials(value: unknown): WebhookCredentials | null {
  if (!isRecord(value)) return null;
  const secret = readString(value.secret) ?? readString(value.signingSecret) ?? readString(value.sharedSecret);
  return secret ? { secret } : null;
}

export function parseWebhookConfig(value: unknown): WebhookConfig | null {
  if (!isRecord(value)) return null;
  const url = readString(value.url) ?? readString(value.endpoint) ?? readString(value.webhookUrl);
  if (!url) return null;
  const headers: Record<string, string> = {};
  if (isRecord(value.headers)) {
    for (const [key, raw] of Object.entries(value.headers)) {
      const header = readString(raw);
      if (header !== undefined) headers[key.toLowerCase()] = header;
    }
  }
  return {
    url,
    headers: Object.keys(headers).length ? headers : undefined,
    timeoutMs: readNumber(value.timeoutMs),
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────

function readAck(res: HttpResult): WebhookAck {
  const body = res.body;
  if (!isRecord(body)) return { ok: true, opaque: true };

  const explicit = readBoolean(body.ok) ?? readBoolean(body.success) ?? readBoolean(body.applied);
  if (explicit === false) {
    return { ok: false, opaque: false, error: providerMessage(res, 'the endpoint reported ok: false') };
  }
  const id = readString(body.id) ?? readString(body.externalId) ?? readString(body.contentId);
  const url = readString(body.url) ?? readString(body.link);
  // A JSON body with no ok/id/url tells us nothing more than the status code did.
  const opaque = explicit === undefined && id === undefined && url === undefined;
  return { ok: true, id, url, opaque };
}

/** Only send keys the caller actually set — an absent key means "leave it alone" to the receiver. */
function contentPayloadToJson(payload: ContentPatch): JsonObject {
  const out: JsonObject = {};
  const assign = (key: string, value: string | undefined): void => {
    if (value !== undefined) out[key] = value;
  };
  assign('title', payload.title);
  assign('slug', payload.slug);
  assign('bodyHtml', payload.bodyHtml);
  assign('bodyMarkdown', payload.bodyMarkdown);
  assign('excerpt', payload.excerpt);
  assign('metaTitle', payload.metaTitle);
  assign('metaDescription', payload.metaDescription);
  assign('status', payload.status);
  assign('container', payload.container);
  assign('commitMessage', payload.commitMessage);
  if (payload.structuredData !== undefined) out.structuredData = toJsonValue(payload.structuredData);
  return out;
}
