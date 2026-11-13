import { describe, expect, it } from 'vitest';
import { socialAccountDataFromPersonal } from '../accounts';

describe('socialAccountDataFromPersonal', () => {
  const personal = {
    handle: 'u/someone',
    displayName: 'someone',
    credentials: { authType: 'oauth2', accessToken: 'a', refreshToken: 'r', expiresAt: '2026-01-01T00:00:00.000Z' },
  };

  it('copies the token as-is and defaults posts to the profile', () => {
    const data = socialAccountDataFromPersonal(personal, {});
    expect(data.credentials).toEqual(personal.credentials);
    expect(data.credentials).not.toBe(personal.credentials);
    expect(data.status).toBe('CONNECTED');
    expect(data.config).toEqual({ defaultCommunity: 'u_someone', linkedFrom: 'personal' });
  });

  it('keeps the site’s own settings over the defaults', () => {
    const data = socialAccountDataFromPersonal(personal, { defaultCommunity: 'r/MyProduct', ownedCommunities: 'r/MyProduct' });
    expect(data.config).toMatchObject({ defaultCommunity: 'r/MyProduct', ownedCommunities: 'r/MyProduct', linkedFrom: 'personal' });
  });
});
