import 'server-only';
import { NextResponse } from 'next/server';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { prisma } from '@seo/db';
import {
  AppError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  createLogger,
  errorMessage,
  toAppError,
} from '@seo/shared';
import { assertCsrf, requireUser, type SessionUser } from './auth';

const log = createLogger('api');

export interface RouteContext<TParams = Record<string, string>> {
  user: SessionUser;
  request: Request;
  params: TParams;
}

type Handler<TParams> = (ctx: RouteContext<TParams>) => Promise<Response | unknown>;

interface RouteOptions {
  /** Skip authentication (only for /api/auth/* and /api/health). */
  public?: boolean;
  /** Skip CSRF validation (only for provider callbacks that cannot carry our header). */
  skipCsrf?: boolean;
}

/**
 * Wrap a route handler with auth, CSRF, error translation and structured logging.
 * Handlers may return a plain object (serialised as JSON) or a Response.
 */
export function route<TParams = Record<string, string>>(
  handler: Handler<TParams>,
  options: RouteOptions = {},
) {
  return async (request: Request, context: { params: Promise<TParams> }): Promise<Response> => {
    const started = Date.now();
    const url = new URL(request.url);
    try {
      if (!options.skipCsrf) await assertCsrf(request);
      const user = options.public
        ? ({ id: '', email: '', name: null, role: 'VIEWER' } satisfies SessionUser)
        : await requireUser();

      const params = (await context.params) ?? ({} as TParams);
      const result = await handler({ user, request, params });

      if (result instanceof Response) return result;
      return NextResponse.json(result ?? { ok: true });
    } catch (err) {
      return handleRouteError(err, `${request.method} ${url.pathname}`, Date.now() - started);
    }
  };
}

export function handleRouteError(err: unknown, label: string, durationMs?: number): Response {
  if (err instanceof ZodError) {
    const issues = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    return NextResponse.json(
      { error: 'Validation failed', code: 'VALIDATION_ERROR', details: issues },
      { status: 400 },
    );
  }

  const appError = toAppError(err);
  const level = appError.status >= 500 ? 'error' : 'warn';
  log[level](`${label} failed`, {
    code: appError.code,
    status: appError.status,
    message: appError.message,
    durationMs,
  });

  // 5xx bodies never leak internals to the client; the detail stays in the server log.
  const body =
    appError.status >= 500
      ? { error: 'Something went wrong on our side. Check the server logs for details.', code: appError.code }
      : appError.toJSON();

  return NextResponse.json(body, { status: appError.status });
}

/** Parse and validate a JSON request body. */
export async function readBody<T extends ZodTypeAny>(request: Request, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new ValidationError('Request body must be valid JSON.');
  }
  return schema.parse(raw);
}

/** Parse and validate query-string parameters. */
export function readQuery<T extends ZodTypeAny>(request: Request, schema: T): z.infer<T> {
  const params = new URL(request.url).searchParams;
  const obj: Record<string, unknown> = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    obj[key] = values.length > 1 ? values : values[0];
  }
  return schema.parse(obj);
}

/**
 * Load a website the current user owns.
 * Every website-scoped route must go through this — it is the single ownership check.
 */
export async function requireWebsite(userId: string, websiteId: string) {
  const website = await prisma.website.findUnique({
    where: { id: websiteId },
    include: { settings: true },
  });
  if (!website) throw new NotFoundError('Website');
  if (website.userId !== userId) throw new ForbiddenError('You do not have access to this website.');
  return website;
}

export function jsonError(message: string, status = 400, code = 'ERROR'): Response {
  return NextResponse.json({ error: message, code }, { status });
}

/** CSV download response with correct escaping and headers. */
export function csvResponse(filename: string, rows: Array<Record<string, unknown>>): Response {
  if (rows.length === 0) {
    return new NextResponse('﻿', {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  }
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const str = value instanceof Date ? value.toISOString() : String(value);
    return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const body =
    '﻿' +
    [columns.join(','), ...rows.map((row) => columns.map((c) => escape(row[c])).join(','))].join('\n');

  return new NextResponse(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

export { AppError, errorMessage };
