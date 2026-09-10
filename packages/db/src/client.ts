import { PrismaClient } from '@prisma/client';

/**
 * Single Prisma client per process. Next.js dev reloads modules on every edit, so the
 * instance is cached on globalThis to avoid exhausting Postgres connections.
 */
const globalForPrisma = globalThis as unknown as { __seoOsPrisma?: PrismaClient };

function create(): PrismaClient {
  return new PrismaClient({
    log:
      process.env.PRISMA_LOG === 'query'
        ? ['query', 'warn', 'error']
        : process.env.NODE_ENV === 'production'
          ? ['warn', 'error']
          : ['warn', 'error'],
  });
}

export const prisma: PrismaClient = globalForPrisma.__seoOsPrisma ?? create();

if (process.env.NODE_ENV !== 'production') globalForPrisma.__seoOsPrisma = prisma;

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}

/** True when the database is reachable — used by the health endpoint and worker boot. */
export async function checkDatabaseConnection(): Promise<{ ok: boolean; error?: string }> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
