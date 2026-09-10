export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;
  readonly retryable: boolean;

  constructor(
    message: string,
    opts: { code?: string; status?: number; details?: unknown; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.code = opts.code ?? 'INTERNAL_ERROR';
    this.status = opts.status ?? 500;
    this.details = opts.details;
    this.retryable = opts.retryable ?? false;
  }

  toJSON() {
    return { error: this.message, code: this.code, details: this.details };
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, { code: 'VALIDATION_ERROR', status: 400, details });
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, { code: 'NOT_FOUND', status: 404 });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, { code: 'UNAUTHORIZED', status: 401 });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have access to this resource') {
    super(message, { code: 'FORBIDDEN', status: 403 });
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, { code: 'CONFLICT', status: 409, details });
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Too many requests', public readonly retryAfterSeconds = 60) {
    super(message, { code: 'RATE_LIMITED', status: 429, retryable: true });
  }
}

/** A required third-party integration is missing or misconfigured. Surfaced as a UI hint, never a crash. */
export class IntegrationNotConfiguredError extends AppError {
  constructor(public readonly provider: string, hint?: string) {
    super(hint ?? `${provider} is not configured`, {
      code: 'INTEGRATION_NOT_CONFIGURED',
      status: 424,
      details: { provider },
    });
  }
}

export class ProviderError extends AppError {
  constructor(provider: string, message: string, retryable = true) {
    super(`${provider}: ${message}`, {
      code: 'PROVIDER_ERROR',
      status: 502,
      details: { provider },
      retryable,
    });
  }
}

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof Error) return new AppError(err.message, { details: { stack: err.stack } });
  return new AppError(String(err));
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
