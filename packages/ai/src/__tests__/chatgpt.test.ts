import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHATGPT_RESOURCE,
  ChatGptError,
  buildAuthorizeUrl,
  classifyRefreshError,
  classifyResponsesError,
  collectResponse,
  exchangeAuthorizationCode,
  hasPlanUsage,
  loopbackRedirectUri,
  parseModelList,
  parseTokenResponse,
  pickDefaultModels,
  pkceChallenge,
  readSse,
  refreshAccessToken,
} from '../chatgpt/index';
import { buildResponsesBody, shouldFallBackToPromptJson } from '../providers/chatgpt';

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

const event = (type: string, payload: Record<string, unknown>) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;

describe('Sign in with ChatGPT — authorize request', () => {
  it('builds the loopback callback on 127.0.0.1 with a fixed path', () => {
    expect(loopbackRedirectUri(3100)).toBe('http://127.0.0.1:3100/api/ai/chatgpt/callback');
    expect(() => loopbackRedirectUri(0)).toThrow(ChatGptError);
  });

  it('computes the RFC 7636 S256 challenge', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('registers dynamically the first time, with every documented parameter', () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: 'dynamic_agent_client',
        redirectUri: 'http://127.0.0.1:3000/api/ai/chatgpt/callback',
        state: 'st',
        nonce: 'no',
        codeChallenge: 'ch',
        hostId: 'urn:uuid:1234',
        idTokenHint: 'ignored-on-first-registration',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://auth.openai.com/api/accounts/authorize');
    const q = url.searchParams;
    expect(q.get('client_id')).toBe('dynamic_agent_client');
    expect(q.get('agent_name_hint')).toBe('SEO OS');
    expect(q.get('ext_agent_host_id')).toBe('urn:uuid:1234');
    expect(q.get('response_type')).toBe('code');
    expect(q.get('redirect_uri')).toBe('http://127.0.0.1:3000/api/ai/chatgpt/callback');
    expect(q.get('scope')).toBe('openid profile email offline_access resource.invoke chatgpt.tokens.use.direct');
    expect(q.get('resource')).toBe(CHATGPT_RESOURCE);
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('code_challenge')).toBe('ch');
    expect(q.get('state')).toBe('st');
    expect(q.get('nonce')).toBe('no');
    expect(q.has('id_token_hint')).toBe(false);
  });

  it('re-authorises an issued registration without the name hint, with login hints', () => {
    const q = new URL(
      buildAuthorizeUrl({
        clientId: 'oaiapp_abc',
        redirectUri: 'http://127.0.0.1:3000/api/ai/chatgpt/callback',
        state: 's',
        nonce: 'n',
        codeChallenge: 'c',
        hostId: 'urn:uuid:1',
        idTokenHint: 'id.token.value',
        loginHint: 'me@example.com',
      }),
    ).searchParams;
    expect(q.get('client_id')).toBe('oaiapp_abc');
    expect(q.has('agent_name_hint')).toBe(false);
    expect(q.get('id_token_hint')).toBe('id.token.value');
    expect(q.get('login_hint')).toBe('me@example.com');
  });
});

describe('token grants', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('parses scope strings and arrays, and checks the plan-usage scope', () => {
    const fromString = parseTokenResponse({ access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: 'openid chatgpt.tokens.use.direct' }, 0);
    expect(fromString.scopes).toEqual(['openid', 'chatgpt.tokens.use.direct']);
    expect(fromString.expiresAt).toBe(3_600_000);
    expect(hasPlanUsage(fromString.scopes)).toBe(true);
    const fromArray = parseTokenResponse({ access_token: 'a', scopes: ['openid', 'profile'] }, 0);
    expect(hasPlanUsage(fromArray.scopes)).toBe(false);
    expect(() => parseTokenResponse({}, 0)).toThrow(ChatGptError);
  });

  it('sends the authorization-code grant form-encoded with resource and the issued client id', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const form = new URLSearchParams(String(init.body));
      expect(Object.fromEntries(form)).toEqual({
        grant_type: 'authorization_code',
        client_id: 'oaiapp_x',
        code: 'the-code',
        code_verifier: 'verifier',
        redirect_uri: 'http://127.0.0.1:3000/api/ai/chatgpt/callback',
        resource: CHATGPT_RESOURCE,
      });
      return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', id_token: 'it', expires_in: 3600, scope: 'openid chatgpt.tokens.use.direct' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const tokens = await exchangeAuthorizationCode({ clientId: 'oaiapp_x', code: 'the-code', codeVerifier: 'verifier', redirectUri: 'http://127.0.0.1:3000/api/ai/chatgpt/callback' });
    expect(tokens.refreshToken).toBe('rt');
    expect(fetchMock).toHaveBeenCalledWith('https://auth.openai.com/api/accounts/oauth/token', expect.objectContaining({ method: 'POST' }));
  });

  it('refreshes without a scope and turns a dead refresh token into a re-sign-in', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const form = new URLSearchParams(String(init.body));
        expect(form.get('grant_type')).toBe('refresh_token');
        expect(form.get('resource')).toBe(CHATGPT_RESOURCE);
        expect(form.has('scope')).toBe(false);
        return new Response(JSON.stringify({ error: 'refresh_token_reused' }), { status: 400 });
      }),
    );
    const error = await refreshAccessToken({ clientId: 'oaiapp_x', refreshToken: 'old' }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ChatGptError);
    expect((error as ChatGptError).needsReauth).toBe(true);
  });

  it('keeps credentials on transient refresh failures', () => {
    const transient = classifyRefreshError(503, null, 'down');
    expect(transient.needsReauth).toBe(false);
    expect(transient.retryable).toBe(true);
    expect(classifyRefreshError(400, 'invalid_grant', null).needsReauth).toBe(true);
  });
});

describe('Responses stream', () => {
  it('concatenates deltas and reads usage from response.completed', async () => {
    const deltas: string[] = [];
    const result = await collectResponse(
      readSse(
        sseStream([
          event('response.created', { response: { id: 'r1' } }),
          event('response.output_text.delta', { delta: 'Hel' }),
          'event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta",',
          '"delta":"lo"}\r\n\r\n',
          ': keep-alive comment\n\n',
          event('response.completed', { response: { model: 'gpt-x', usage: { input_tokens: 12, output_tokens: 3 } } }),
        ]),
      ),
      (delta) => deltas.push(delta),
    );
    expect(result).toMatchObject({ text: 'Hello', outcome: 'completed', model: 'gpt-x', tokensIn: 12, tokensOut: 3 });
    expect(deltas).toEqual(['Hel', 'lo']);
  });

  it('reports an incomplete answer separately from a completed one', async () => {
    const result = await collectResponse(
      readSse(sseStream([event('response.output_text.delta', { delta: 'partial' }), event('response.incomplete', { response: { incomplete_details: { reason: 'max_output_tokens' } } })])),
    );
    expect(result.outcome).toBe('incomplete');
    expect(result.incompleteReason).toBe('max_output_tokens');
  });

  it('fails a stream that started fine but ended in response.failed (cap hit mid-answer)', async () => {
    const error = await collectResponse(
      readSse(sseStream([event('response.output_text.delta', { delta: 'x' }), event('response.failed', { response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'cap' } } })])),
    ).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ChatGptError);
    expect((error as ChatGptError).kind).toBe('usage-limit');
    expect((error as ChatGptError).retryable).toBe(false);
  });

  it('never reports an interrupted stream as success', async () => {
    const error = await collectResponse(readSse(sseStream([event('response.output_text.delta', { delta: 'x' })]))).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ChatGptError);
    expect((error as ChatGptError).retryable).toBe(true);
  });
});

describe('error mapping', () => {
  it('maps every documented code to its recovery', () => {
    expect(classifyResponsesError({ status: 429, code: 'subscription_sharing_usage_limit_exceeded' })).toMatchObject({ kind: 'usage-limit', retryable: false });
    expect(classifyResponsesError({ status: 403, code: 'subscription_sharing_user_not_eligible' })).toMatchObject({ kind: 'not-eligible', retryable: false });
    expect(classifyResponsesError({ status: 503, code: 'subscription_sharing_usage_unavailable' })).toMatchObject({ kind: 'unavailable', retryable: true });
    expect(classifyResponsesError({ status: 503, code: 'subscription_sharing_user_unavailable' })).toMatchObject({ kind: 'unavailable', retryable: true });
    expect(classifyResponsesError({ status: 400, code: 'subscription_sharing_unsupported_capability', param: 'text.format' })).toMatchObject({ kind: 'unsupported', param: 'text.format' });
    expect(classifyResponsesError({ status: 401, code: 'subscription_sharing_invalid_user' })).toMatchObject({ kind: 'invalid-user' });
    expect(classifyResponsesError({ status: 403, code: 'chatpass_v2_scope_not_authorized' })).toMatchObject({ kind: 'not-authorized' });
    expect(classifyResponsesError({ status: 502, code: null })).toMatchObject({ kind: 'upstream', retryable: true });
  });

  it('falls back to prompt JSON only when the schema parameter is what was rejected', () => {
    expect(shouldFallBackToPromptJson(classifyResponsesError({ status: 400, code: 'subscription_sharing_unsupported_capability', param: 'text.format' }))).toBe(true);
    expect(shouldFallBackToPromptJson(classifyResponsesError({ status: 400, code: 'subscription_sharing_unsupported_capability' }))).toBe(true);
    expect(shouldFallBackToPromptJson(classifyResponsesError({ status: 400, code: 'subscription_sharing_unsupported_capability', param: 'model' }))).toBe(false);
    expect(shouldFallBackToPromptJson(classifyResponsesError({ status: 429, code: 'subscription_sharing_usage_limit_exceeded' }))).toBe(false);
  });
});

describe('models and request body', () => {
  it('keeps listed models in server order and picks role defaults', () => {
    const models = parseModelList({
      models: [
        { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1', visibility: 'list' },
        { slug: 'internal-x', display_name: 'Hidden', visibility: 'hide' },
        { slug: 'gpt-6.1-mini', display_name: 'GPT-6.1 mini', visibility: 'list' },
      ],
    });
    expect(models.map((model) => model.slug)).toEqual(['gpt-6.1-sol', 'gpt-6.1-mini']);
    expect(pickDefaultModels(models)).toEqual({ reasoning: 'gpt-6.1-sol', writing: 'gpt-6.1-sol', fast: 'gpt-6.1-mini', embedding: null });
    expect(pickDefaultModels([])).toEqual({ reasoning: null, writing: null, fast: null, embedding: null });
  });

  it('always streams, never stores, and sends no sampling parameters', () => {
    const body = buildResponsesBody(
      [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Hi' },
      ],
      { temperature: 0.2, maxTokens: 100 },
      'gpt-6.1-sol',
      { instructionsSuffix: 'Return JSON.' },
    );
    expect(body).toEqual({
      model: 'gpt-6.1-sol',
      instructions: 'Be brief.\n\nReturn JSON.',
      input: [{ role: 'user', content: 'Hi' }],
      store: false,
      stream: true,
    });
  });
});
