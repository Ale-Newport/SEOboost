import { describe, expect, it } from 'vitest';
import { clientIp } from '@/lib/rate-limit';

const req = (headers: Record<string, string>) => new Request('http://localhost/api/auth/login', { headers });

describe('clientIp', () => {
  it('takes the first X-Forwarded-For hop', () => {
    expect(clientIp(req({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }))).toBe('203.0.113.7');
  });

  it('falls back to X-Real-IP, then to "unknown"', () => {
    expect(clientIp(req({ 'x-real-ip': '198.51.100.2' }))).toBe('198.51.100.2');
    expect(clientIp(req({}))).toBe('unknown');
  });

  it('bounds the key length of a hostile header', () => {
    expect(clientIp(req({ 'x-forwarded-for': 'x'.repeat(10_000) })).length).toBe(64);
  });
});
