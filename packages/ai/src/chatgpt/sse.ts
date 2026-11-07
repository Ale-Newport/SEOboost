import { ChatGptError, classifyResponsesError } from './errors';

/**
 * Server-sent events from `POST /v1/responses` with `stream: true`.
 *
 * Plan usage only works streamed, and the spec is explicit that a stream can start fine and
 * still end in `response.failed` (a cap hit mid-answer) — so success is `response.completed`
 * and nothing else. Text is the concatenation of `response.output_text.delta` events.
 */

export interface SseEvent {
  event: string | null;
  data: string;
}

/** Split an SSE byte stream into events. Handles CRLF, multi-line `data:` and comments. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName: string | null = null;
  let dataLines: string[] = [];

  const flush = (): SseEvent | null => {
    if (dataLines.length === 0) {
      eventName = null;
      return null;
    }
    const out = { event: eventName, data: dataLines.join('\n') };
    eventName = null;
    dataLines = [];
    return out;
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline = buffer.search(/\r?\n/);
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + (buffer[newline] === '\r' ? 2 : 1));
        if (line === '') {
          const event = flush();
          if (event) yield event;
        } else if (!line.startsWith(':')) {
          const colon = line.indexOf(':');
          const field = colon === -1 ? line : line.slice(0, colon);
          const rawValue = colon === -1 ? '' : line.slice(colon + 1);
          const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;
          if (field === 'event') eventName = value;
          else if (field === 'data') dataLines.push(value);
        }
        newline = buffer.search(/\r?\n/);
      }
      if (done) break;
    }
    if (buffer.trim()) {
      // A final event without its blank-line terminator.
      if (buffer.startsWith('data:')) dataLines.push(buffer.slice(5).trimStart());
    }
    const last = flush();
    if (last) yield last;
  } finally {
    reader.releaseLock();
  }
}

export type ResponseOutcome = 'completed' | 'incomplete';

export interface CollectedResponse {
  text: string;
  outcome: ResponseOutcome;
  /** `incomplete_details.reason` when the answer was cut short. */
  incompleteReason: string | null;
  model: string | null;
  tokensIn: number;
  tokensOut: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function usageOf(response: Record<string, unknown> | null): { tokensIn: number; tokensOut: number } {
  const usage = record(response?.usage);
  const input = usage?.input_tokens;
  const output = usage?.output_tokens;
  return {
    tokensIn: typeof input === 'number' ? input : 0,
    tokensOut: typeof output === 'number' ? output : 0,
  };
}

/**
 * Consume a Responses stream into a result, yielding text deltas through `onDelta`.
 *
 * Throws a typed `ChatGptError` on `response.failed`, an `error` event, or a stream that ends
 * without a terminal event — an interrupted stream is never reported as a finished answer.
 */
export async function collectResponse(
  events: AsyncIterable<SseEvent>,
  onDelta?: (delta: string) => void,
): Promise<CollectedResponse> {
  let text = '';
  for await (const raw of events) {
    if (raw.data === '[DONE]') break;
    let payload: Record<string, unknown> | null;
    try {
      payload = record(JSON.parse(raw.data) as unknown);
    } catch {
      continue;
    }
    if (!payload) continue;
    const type = typeof payload.type === 'string' ? payload.type : raw.event;

    switch (type) {
      case 'response.output_text.delta': {
        const delta = payload.delta;
        if (typeof delta === 'string' && delta) {
          text += delta;
          onDelta?.(delta);
        }
        break;
      }
      case 'response.completed': {
        const response = record(payload.response);
        return {
          text,
          outcome: 'completed',
          incompleteReason: null,
          model: typeof response?.model === 'string' ? response.model : null,
          ...usageOf(response),
        };
      }
      case 'response.incomplete': {
        const response = record(payload.response);
        const details = record(response?.incomplete_details);
        return {
          text,
          outcome: 'incomplete',
          incompleteReason: typeof details?.reason === 'string' ? details.reason : null,
          model: typeof response?.model === 'string' ? response.model : null,
          ...usageOf(response),
        };
      }
      case 'response.failed': {
        const response = record(payload.response);
        const error = record(response?.error);
        throw classifyResponsesError({
          status: null,
          code: typeof error?.code === 'string' ? error.code : null,
          message: typeof error?.message === 'string' ? error.message : null,
          param: typeof error?.param === 'string' ? error.param : null,
        });
      }
      case 'error': {
        const error = record(payload.error) ?? payload;
        throw classifyResponsesError({
          status: null,
          code: typeof error.code === 'string' ? error.code : null,
          message: typeof error.message === 'string' ? error.message : null,
          param: typeof error.param === 'string' ? error.param : null,
        });
      }
      default:
        break;
    }
  }
  throw new ChatGptError({
    kind: 'upstream',
    retryable: true,
    message: 'The ChatGPT stream ended before the response completed.',
  });
}
