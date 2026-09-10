import { describe, expect, it } from 'vitest';
import {
  WEBHOOK_DEFAULT_TOLERANCE_SECONDS,
  WEBHOOK_SIGNATURE_PREFIX,
  computeWebhookSignature,
  verifyWebhookSignature,
} from '../webhook';

/**
 * The sign/verify pair is the whole security boundary of the webhook adapter: a receiver
 * that trusts an unverified body would let anyone rewrite a customer's pages. These tests
 * pin the properties that matter — round-trip, tamper detection, and replay rejection.
 */

const SECRET = 'whsec_test_secret_value';
const BODY = JSON.stringify({ version: 1, operation: 'updateContent', data: { title: 'Hello' } });
const NOW = 1_757_000_000;

describe('computeWebhookSignature', () => {
  it('produces a prefixed lowercase hex HMAC and echoes the timestamp', () => {
    const signed = computeWebhookSignature({ body: BODY, secret: SECRET, timestamp: NOW });
    expect(signed.timestamp).toBe(String(NOW));
    expect(signed.signature.startsWith(WEBHOOK_SIGNATURE_PREFIX)).toBe(true);
    expect(signed.signature.slice(WEBHOOK_SIGNATURE_PREFIX.length)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same body, secret and timestamp', () => {
    const a = computeWebhookSignature({ body: BODY, secret: SECRET, timestamp: NOW });
    const b = computeWebhookSignature({ body: BODY, secret: SECRET, timestamp: NOW });
    expect(a.signature).toBe(b.signature);
  });

  it('binds the timestamp into the MAC, so the same body at another second signs differently', () => {
    const a = computeWebhookSignature({ body: BODY, secret: SECRET, timestamp: NOW });
    const b = computeWebhookSignature({ body: BODY, secret: SECRET, timestamp: NOW + 1 });
    expect(a.signature).not.toBe(b.signature);
  });
});

describe('verifyWebhookSignature', () => {
  const sign = (body = BODY, timestamp = NOW, secret = SECRET) =>
    computeWebhookSignature({ body, secret, timestamp });

  it('accepts a freshly signed delivery', () => {
    const signed = sign();
    const result = verifyWebhookSignature({
      body: BODY,
      timestamp: signed.timestamp,
      signature: signed.signature,
      secret: SECRET,
      nowSeconds: NOW,
    });
    expect(result).toEqual({ valid: true });
  });

  it('accepts a signature sent without the sha256= prefix', () => {
    const signed = sign();
    const result = verifyWebhookSignature({
      body: BODY,
      timestamp: signed.timestamp,
      signature: signed.signature.slice(WEBHOOK_SIGNATURE_PREFIX.length),
      secret: SECRET,
      nowSeconds: NOW,
    });
    expect(result.valid).toBe(true);
  });

  it('rejects a tampered body', () => {
    const signed = sign();
    const result = verifyWebhookSignature({
      body: BODY.replace('Hello', 'Goodbye'),
      timestamp: signed.timestamp,
      signature: signed.signature,
      secret: SECRET,
      nowSeconds: NOW,
    });
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.reason).toBe('SIGNATURE_MISMATCH');
  });

  it('rejects a signature made with a different secret', () => {
    const signed = sign(BODY, NOW, 'whsec_someone_elses_secret');
    const result = verifyWebhookSignature({
      body: BODY,
      timestamp: signed.timestamp,
      signature: signed.signature,
      secret: SECRET,
      nowSeconds: NOW,
    });
    expect(result.valid === false && result.reason).toBe('SIGNATURE_MISMATCH');
  });

  it('rejects a replayed delivery once it falls outside the tolerance window', () => {
    const signed = sign();
    const stale = verifyWebhookSignature({
      body: BODY,
      timestamp: signed.timestamp,
      signature: signed.signature,
      secret: SECRET,
      nowSeconds: NOW + WEBHOOK_DEFAULT_TOLERANCE_SECONDS + 1,
    });
    expect(stale.valid).toBe(false);
    expect(stale.valid === false && stale.reason).toBe('TIMESTAMP_OUT_OF_TOLERANCE');

    // The very same delivery is still valid at the edge of the window — the check is a
    // window, not a nonce, so the boundary has to be exact.
    const fresh = verifyWebhookSignature({
      body: BODY,
      timestamp: signed.timestamp,
      signature: signed.signature,
      secret: SECRET,
      nowSeconds: NOW + WEBHOOK_DEFAULT_TOLERANCE_SECONDS,
    });
    expect(fresh.valid).toBe(true);
  });

  it('rejects a delivery timestamped too far in the future (a skewed or forged clock)', () => {
    const future = NOW + 10_000;
    const signed = sign(BODY, future);
    const result = verifyWebhookSignature({
      body: BODY,
      timestamp: signed.timestamp,
      signature: signed.signature,
      secret: SECRET,
      nowSeconds: NOW,
    });
    expect(result.valid === false && result.reason).toBe('TIMESTAMP_OUT_OF_TOLERANCE');
  });

  it('honours a custom tolerance', () => {
    const signed = sign();
    const result = verifyWebhookSignature({
      body: BODY,
      timestamp: signed.timestamp,
      signature: signed.signature,
      secret: SECRET,
      toleranceSeconds: 5,
      nowSeconds: NOW + 6,
    });
    expect(result.valid === false && result.reason).toBe('TIMESTAMP_OUT_OF_TOLERANCE');
  });

  it('rejects a replay that rewrites the timestamp header to look fresh', () => {
    const signed = sign();
    const replayedAt = NOW + 10_000;
    const result = verifyWebhookSignature({
      body: BODY,
      // Attacker keeps the captured signature but claims it was sent now.
      timestamp: String(replayedAt),
      signature: signed.signature,
      secret: SECRET,
      nowSeconds: replayedAt,
    });
    expect(result.valid === false && result.reason).toBe('SIGNATURE_MISMATCH');
  });

  it('reports missing headers and secrets distinctly instead of a generic failure', () => {
    const signed = sign();
    expect(
      verifyWebhookSignature({ body: BODY, timestamp: signed.timestamp, signature: null, secret: SECRET }).valid,
    ).toBe(false);

    const noSignature = verifyWebhookSignature({
      body: BODY,
      timestamp: signed.timestamp,
      signature: undefined,
      secret: SECRET,
      nowSeconds: NOW,
    });
    expect(noSignature.valid === false && noSignature.reason).toBe('MISSING_SIGNATURE');

    const noTimestamp = verifyWebhookSignature({
      body: BODY,
      timestamp: null,
      signature: signed.signature,
      secret: SECRET,
      nowSeconds: NOW,
    });
    expect(noTimestamp.valid === false && noTimestamp.reason).toBe('MISSING_TIMESTAMP');

    const noSecret = verifyWebhookSignature({
      body: BODY,
      timestamp: signed.timestamp,
      signature: signed.signature,
      secret: '',
      nowSeconds: NOW,
    });
    expect(noSecret.valid === false && noSecret.reason).toBe('MISSING_SECRET');

    const badTimestamp = verifyWebhookSignature({
      body: BODY,
      timestamp: 'not-a-number',
      signature: signed.signature,
      secret: SECRET,
      nowSeconds: NOW,
    });
    expect(badTimestamp.valid === false && badTimestamp.reason).toBe('MALFORMED_TIMESTAMP');
  });

  it('rejects a signature of the wrong length without throwing (constant-time compare guard)', () => {
    const result = verifyWebhookSignature({
      body: BODY,
      timestamp: String(NOW),
      signature: 'sha256=deadbeef',
      secret: SECRET,
      nowSeconds: NOW,
    });
    expect(result.valid === false && result.reason).toBe('SIGNATURE_MISMATCH');
  });
});
