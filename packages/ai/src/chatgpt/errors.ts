import { ProviderError } from '@seo/shared';

/**
 * Typed failures of the ChatGPT plan route.
 *
 * The codes are OpenAI's documented ones; what this module adds is the recovery each one
 * demands. Retrying a usage-limit or not-eligible error is explicitly wrong (it burns the
 * user's cap or loops forever), while a temporary unavailability must keep the credentials and
 * back off — so `retryable` and `needsReauth` are decided here, once, from the code.
 */

export type ChatGptErrorKind =
  | 'usage-limit'
  | 'not-eligible'
  | 'unavailable'
  | 'unsupported'
  | 'route'
  | 'invalid-user'
  | 'not-authorized'
  | 'reauth'
  | 'not-connected'
  | 'plan-not-granted'
  | 'incomplete'
  | 'upstream';

export class ChatGptError extends ProviderError {
  readonly kind: ChatGptErrorKind;
  readonly errorCode: string | null;
  readonly httpStatus: number | null;
  /** The request parameter the API objected to, for `subscription_sharing_unsupported_capability`. */
  readonly param: string | null;
  /** True when the stored grant is unusable and the user has to sign in again. */
  readonly needsReauth: boolean;

  constructor(params: {
    kind: ChatGptErrorKind;
    message: string;
    code?: string | null;
    status?: number | null;
    param?: string | null;
    retryable?: boolean;
    needsReauth?: boolean;
  }) {
    super('chatgpt', params.message, params.retryable ?? false);
    this.name = 'ChatGptError';
    this.kind = params.kind;
    this.errorCode = params.code ?? null;
    this.httpStatus = params.status ?? null;
    this.param = params.param ?? null;
    this.needsReauth = params.needsReauth ?? false;
  }
}

const MANAGE_USAGE = 'Manage the cap at chatgpt.com/settings/usage.';

/** Map a Responses API error (HTTP or mid-stream) onto the documented recovery. */
export function classifyResponsesError(input: {
  status: number | null;
  code: string | null;
  message?: string | null;
  param?: string | null;
}): ChatGptError {
  const { status, code } = input;
  const detail = input.message?.trim() || code || (status ? `HTTP ${status}` : 'unknown error');
  const base = { code, status, param: input.param ?? null };

  switch (code) {
    case 'subscription_sharing_usage_limit_exceeded':
      return new ChatGptError({ ...base, kind: 'usage-limit', message: `ChatGPT plan usage limit reached for this app. ${MANAGE_USAGE}` });
    case 'subscription_sharing_user_not_eligible':
      return new ChatGptError({ ...base, kind: 'not-eligible', message: 'This ChatGPT account cannot use its plan in other apps (it needs ChatGPT Plus or Pro, and the workspace must allow it).' });
    case 'subscription_sharing_usage_unavailable':
    case 'subscription_sharing_user_unavailable':
      return new ChatGptError({ ...base, kind: 'unavailable', message: `ChatGPT plan usage is temporarily unavailable (${code}).`, retryable: true });
    case 'subscription_sharing_unsupported_capability':
      return new ChatGptError({ ...base, kind: 'unsupported', message: `ChatGPT plan usage does not support ${input.param ? `"${input.param}"` : 'part of this request'}: ${detail}` });
    case 'subscription_sharing_route_not_supported':
      return new ChatGptError({ ...base, kind: 'route', message: `ChatGPT plan usage rejected the endpoint: ${detail}` });
    case 'subscription_sharing_invalid_user':
      return new ChatGptError({ ...base, kind: 'invalid-user', message: `ChatGPT could not validate the signed-in account: ${detail}` });
    case 'chatpass_v2_scope_not_authorized':
    case 'chatpass_v2_invalid_authorization_context':
      return new ChatGptError({ ...base, kind: 'not-authorized', message: `ChatGPT did not authorise this request (${code}).` });
    default:
      break;
  }

  if (status === 401) {
    return new ChatGptError({ ...base, kind: 'invalid-user', message: `ChatGPT rejected the access token (HTTP 401): ${detail}` });
  }
  if (status === 403) {
    return new ChatGptError({ ...base, kind: 'not-authorized', message: `ChatGPT refused the request (HTTP 403): ${detail}` });
  }
  if (status === 429) {
    return new ChatGptError({ ...base, kind: 'usage-limit', message: `ChatGPT is rate limiting this app (HTTP 429): ${detail}. ${MANAGE_USAGE}` });
  }
  if (status === 400) {
    return new ChatGptError({ ...base, kind: 'unsupported', message: `ChatGPT rejected the request (HTTP 400): ${detail}` });
  }
  // 5xx, a dropped stream or a network failure: keep the credentials and back off.
  return new ChatGptError({ ...base, kind: 'upstream', message: `ChatGPT request failed: ${detail}`, retryable: status === null || status >= 500 });
}

/** Refresh errors after which the stored refresh token is dead. */
const TERMINAL_REFRESH_CODES = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
]);

export function classifyRefreshError(status: number, code: string | null, message: string | null): ChatGptError {
  if (code && TERMINAL_REFRESH_CODES.has(code)) {
    return new ChatGptError({
      kind: 'reauth',
      code,
      status,
      needsReauth: true,
      message: `The ChatGPT sign-in has expired or was revoked (${code}). Sign in with ChatGPT again in Settings → AI providers.`,
    });
  }
  if (code === 'invalid_client') {
    return new ChatGptError({ kind: 'reauth', code, status, needsReauth: true, message: 'ChatGPT no longer recognises this app registration (invalid_client). Sign in with ChatGPT again.' });
  }
  // Network trouble or a 5xx is not a revocation: the credentials stay, the call is retried later.
  return new ChatGptError({
    kind: 'upstream',
    code,
    status,
    retryable: status === 0 || status >= 500 || status === 429,
    message: `Refreshing the ChatGPT token failed (HTTP ${status}${code ? `, ${code}` : ''})${message ? `: ${message}` : ''}.`,
  });
}
