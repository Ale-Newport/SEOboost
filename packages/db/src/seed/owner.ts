import bcrypt from 'bcryptjs';
import { emailSchema, passwordSchema } from '@seo/shared';
import { prisma } from '../client';
import { ok, skipped, type SeedStepResult } from './types';

/**
 * `SEED_EMAIL` / `SEED_PASSWORD` are read from `process.env` directly, and only here.
 *
 * They are seed-only variables: they exist so a fresh install can be provisioned without a human
 * at a browser (docker compose, CI, a scripted first boot). They are deliberately NOT part of
 * `env` in @seo/shared, because nothing else in the platform may ever read them — exposing them
 * through the shared accessor would invite runtime code to depend on a credential that is only
 * meant to exist for the duration of one `db:seed` run.
 */
function readSeedCredentials(): { email?: string; password?: string } {
  return { email: process.env.SEED_EMAIL, password: process.env.SEED_PASSWORD };
}

/** Must match `hashPassword()` in apps/web/src/lib/auth.ts, or the seeded account cannot log in. */
const BCRYPT_ROUNDS = 12;

const SIGNUP_INSTRUCTIONS =
  'Open the app and create the first account at /signup (allowed while ALLOW_SIGNUP is true), ' +
  'or re-run with SEED_EMAIL=you@example.com SEED_PASSWORD=<10+ chars, letters + a number> npm run db:seed';

export interface OwnerResult {
  result: SeedStepResult;
  /** The account demo data can be attached to, when one exists. */
  userId: string | null;
}

/**
 * Create the owner account when seed credentials are supplied.
 *
 * Never resets an existing account's password: an operator re-running the seed after an upgrade
 * would otherwise silently have their credentials rolled back to whatever is in the shell history.
 */
export async function ensureOwnerAccount(): Promise<OwnerResult> {
  const { email: rawEmail, password: rawPassword } = readSeedCredentials();

  if (!rawEmail || !rawPassword) {
    const existing = await prisma.user.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true, email: true } });
    if (existing) {
      return {
        userId: existing.id,
        result: ok(`no SEED_EMAIL/SEED_PASSWORD supplied; existing account ${existing.email} left untouched`),
      };
    }
    return {
      userId: null,
      result: skipped('SEED_EMAIL and SEED_PASSWORD were not both provided, so no account was created.', SIGNUP_INSTRUCTIONS),
    };
  }

  // Validate with the same schemas the signup form uses, so a seeded account can never be one the
  // UI would have rejected.
  const email = emailSchema.safeParse(rawEmail);
  if (!email.success) {
    throw new Error(`SEED_EMAIL is not a valid email address: ${email.error.issues[0]?.message ?? 'invalid'}`);
  }
  const password = passwordSchema.safeParse(rawPassword);
  if (!password.success) {
    throw new Error(`SEED_PASSWORD is rejected by the password policy: ${password.error.issues[0]?.message ?? 'invalid'}`);
  }

  const existing = await prisma.user.findUnique({ where: { email: email.data }, select: { id: true } });
  if (existing) {
    return {
      userId: existing.id,
      result: ok(`account ${email.data} already exists — password and role left unchanged`),
    };
  }

  const user = await prisma.user.create({
    data: {
      email: email.data,
      name: email.data.split('@')[0],
      passwordHash: await bcrypt.hash(password.data, BCRYPT_ROUNDS),
      role: 'OWNER',
    },
    select: { id: true },
  });

  return { userId: user.id, result: ok(`owner account created for ${email.data}`, { User: 1 }) };
}
