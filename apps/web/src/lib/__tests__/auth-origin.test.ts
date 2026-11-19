import { describe, expect, it } from 'vitest';
import { isSameOrigin } from '@/lib/auth';

describe('isSameOrigin', () => {
  const app = 'https://seo.example.com';

  it('accepts the exact app origin', () => {
    expect(isSameOrigin('https://seo.example.com', app)).toBe(true);
  });

  it.each([null, '', 'null', 'not a url', 'https://evil.example', 'http://seo.example.com', 'https://seo.example.com.evil.example'])(
    'rejects %j without throwing',
    (origin) => {
      expect(isSameOrigin(origin, app)).toBe(false);
    },
  );
});
