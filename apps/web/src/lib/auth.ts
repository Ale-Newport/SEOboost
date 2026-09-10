import 'server-only';
import { cookies, headers } from 'next/headers';
import { SignJWT, jwtVerify } from 'jose';
import bcrypt from 'bcryptjs';
import { prisma } from '@seo/db';
import { ConflictError, UnauthorizedError, ValidationError, createLogger, env } from '@seo/shared';
import { constantTimeEquals, hashToken, randomToken } from '@seo/shared/crypto';

const log = createLogger('auth');

const SESSION_COOKIE = 'seo_os_session';
const CSRF_COOKIE = 'seo_os_csrf';
const SESSION_DAYS = 30;
const BCRYPT_ROUNDS = 12;

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  role: string;
}

function secretKey(): Uint8Array {
  return new TextEncoder().encode(env.authSecret);
}

/**
 * Sessions are database-backed with a JWT carrier.
 *
 * The JWT gives us a stateless fast path, but every request still validates the session row so
 * that logging out — or deleting a user — takes effect immediately rather than at token expiry.
 */
async function signSessionToken(payload: { sub: string; sid: string }): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer('seo-os')
    .setAudience('seo-os')
    .setExpirationTime(`${SESSION_DAYS}d`)
    .sign(secretKey());
}

async function verifySessionToken(token: string): Promise<{ sub: string; sid: string } | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), { issuer: 'seo-os', audience: 'seo-os' });
    if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') return null;
    return { sub: payload.sub, sid: payload.sid };
  } catch {
    return null;
  }
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export async function createSession(userId: string): Promise<void> {
  const rawToken = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);

  const headerList = await headers();
  const session = await prisma.session.create({
    data: {
      userId,
      tokenHash: hashToken(rawToken),
      userAgent: headerList.get('user-agent')?.slice(0, 500) ?? null,
      ip: (headerList.get('x-forwarded-for') ?? '').split(',')[0]?.trim() || null,
      expiresAt,
    },
  });

  const jwt = await signSessionToken({ sub: userId, sid: `${session.id}.${rawToken}` });
  const cookieStore = await cookies();
  const secure = env.appUrl.startsWith('https://');

  cookieStore.set(SESSION_COOKIE, jwt, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
  // Double-submit CSRF token: readable by JS, compared against the header on mutations.
  cookieStore.set(CSRF_COOKIE, randomToken(24), {
    httpOnly: false,
    secure,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });

  await prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
}

export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (token) {
    const payload = await verifySessionToken(token);
    if (payload) {
      const [sessionId] = payload.sid.split('.');
      if (sessionId) {
        await prisma.session.deleteMany({ where: { id: sessionId } }).catch(() => undefined);
      }
    }
  }
  cookieStore.delete(SESSION_COOKIE);
  cookieStore.delete(CSRF_COOKIE);
}

/** Current user, or null. Safe to call from any server component or route handler. */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const payload = await verifySessionToken(token);
  if (!payload) return null;

  const [sessionId, rawToken] = payload.sid.split('.');
  if (!sessionId || !rawToken) return null;

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { user: { select: { id: true, email: true, name: true, role: true, isActive: true } } },
  });

  if (!session || session.expiresAt < new Date()) return null;
  if (!constantTimeEquals(session.tokenHash, hashToken(rawToken))) {
    log.warn('session token hash mismatch', { sessionId });
    return null;
  }
  if (!session.user.isActive) return null;

  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role: session.user.role,
  };
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) throw new UnauthorizedError();
  return user;
}

/**
 * Double-submit CSRF check for mutating requests.
 * Same-origin checks alone are not enough behind proxies, so we compare the cookie against a
 * header the browser cannot set cross-origin.
 */
export async function assertCsrf(request: Request): Promise<void> {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;

  const cookieStore = await cookies();
  const cookieToken = cookieStore.get(CSRF_COOKIE)?.value;
  const headerToken = request.headers.get('x-csrf-token');

  if (!cookieToken || !headerToken || !constantTimeEquals(cookieToken, headerToken)) {
    // Fall back to an origin check so first-party form posts without JS still work.
    const origin = request.headers.get('origin');
    if (origin && new URL(origin).origin === new URL(env.appUrl).origin) return;
    throw new UnauthorizedError('Invalid CSRF token. Refresh the page and try again.');
  }
}

export const CSRF_COOKIE_NAME = CSRF_COOKIE;
export const SESSION_COOKIE_NAME = SESSION_COOKIE;

export async function signup(input: { email: string; password: string; name?: string }): Promise<SessionUser> {
  const userCount = await prisma.user.count();
  if (userCount > 0 && !env.allowSignup) {
    throw new ConflictError('Signup is disabled on this installation. Ask the owner to create your account.');
  }

  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) throw new ConflictError('An account with that email already exists.');

  const user = await prisma.user.create({
    data: {
      email: input.email,
      name: input.name ?? null,
      passwordHash: await hashPassword(input.password),
      // The first account owns the installation.
      role: userCount === 0 ? 'OWNER' : 'EDITOR',
    },
    select: { id: true, email: true, name: true, role: true },
  });

  await createSession(user.id);
  log.info('account created', { userId: user.id, isFirstUser: userCount === 0 });
  return user;
}

export async function login(input: { email: string; password: string }): Promise<SessionUser> {
  const user = await prisma.user.findUnique({ where: { email: input.email } });

  // Always run a bcrypt comparison so response timing does not reveal whether the email exists.
  const hash = user?.passwordHash ?? '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin';
  const valid = await verifyPassword(input.password, hash);

  if (!user || !valid) throw new ValidationError('Incorrect email or password.');
  if (!user.isActive) throw new ValidationError('This account has been deactivated.');

  await createSession(user.id);
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

/** Remove expired sessions. Called by the maintenance job. */
export async function pruneExpiredSessions(): Promise<number> {
  const result = await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return result.count;
}

export async function hasAnyUser(): Promise<boolean> {
  return (await prisma.user.count()) > 0;
}
