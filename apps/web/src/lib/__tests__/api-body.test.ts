import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MAX_JSON_BODY_BYTES, readBody, readTextWithLimit } from '@/lib/api';

function streamingRequest(chunks: string[], headers: Record<string, string> = {}): Request {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Request('http://localhost/api/x', { method: 'POST', body, headers, duplex: 'half' } as RequestInit);
}

describe('readTextWithLimit', () => {
  it('returns bodies under the limit', async () => {
    await expect(readTextWithLimit(streamingRequest(['{"a":', '1}']), 100)).resolves.toBe('{"a":1}');
  });

  it('rejects a declared content-length over the limit without reading the body', async () => {
    const request = streamingRequest(['x'], { 'content-length': String(MAX_JSON_BODY_BYTES + 1) });
    await expect(readTextWithLimit(request)).rejects.toThrow(/too large/i);
  });

  it('rejects a body that grows past the limit while streaming, with no content-length', async () => {
    const request = streamingRequest(['a'.repeat(60), 'b'.repeat(60)]);
    await expect(readTextWithLimit(request, 100)).rejects.toThrow(/too large/i);
  });
});

describe('readBody', () => {
  const schema = z.object({ name: z.string() });

  it('parses and validates JSON', async () => {
    await expect(readBody(streamingRequest(['{"name":"x"}']), schema)).resolves.toEqual({ name: 'x' });
  });

  it('rejects invalid JSON with a validation error', async () => {
    await expect(readBody(streamingRequest(['{nope']), schema)).rejects.toThrow(/valid JSON/);
  });
});
