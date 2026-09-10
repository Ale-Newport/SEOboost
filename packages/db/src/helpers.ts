import { Prisma } from '@prisma/client';
import { prisma } from './client';

/** Postgres unique-constraint violation. */
export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export function isNotFound(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025';
}

/** Insert many rows, ignoring duplicates, in chunks that stay under Postgres parameter limits. */
export async function createManyChunked<T>(
  model: { createMany: (args: { data: T[]; skipDuplicates?: boolean }) => Promise<{ count: number }> },
  rows: T[],
  chunkSize = 500,
): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const slice = rows.slice(i, i + chunkSize);
    if (!slice.length) continue;
    const res = await model.createMany({ data: slice, skipDuplicates: true });
    inserted += res.count;
  }
  return inserted;
}

/** JSON value helper that satisfies Prisma's Json input type. */
export function json(value: unknown): Prisma.InputJsonValue {
  return (value ?? null) as Prisma.InputJsonValue;
}

export function jsonOrNull(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value === null || value === undefined ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
}

/** Read a JSON column into a typed shape with a fallback. */
export function readJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  return value as T;
}

/**
 * Global app settings, stored as a single key/value table so the operator can change
 * defaults without redeploying.
 */
export async function getAppSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await prisma.appSetting.findUnique({ where: { key } });
  return row ? (row.value as T) : fallback;
}

export async function setAppSetting(key: string, value: unknown): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value: json(value) },
    update: { value: json(value) },
  });
}

export const paginate = (page: number, pageSize: number) => ({
  skip: Math.max(0, (page - 1) * pageSize),
  take: pageSize,
});

export function buildPaginated<T>(items: T[], total: number, page: number, pageSize: number) {
  return {
    items,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}
