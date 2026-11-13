import { describe, expect, it } from 'vitest';
import {
  buildReferences,
  buildResponse,
  forwardSubject,
  parseRecipients,
  replyRecipients,
  replySubject,
} from '../compose';
import { detectMailPreset } from '../presets';
import { sanitizeEmailHtml } from '../sanitize';
import { parseRawMessage } from '../parse';
import { readImapSmtpConfig } from '../index';
import type { MailMessage } from '../types';

const original = (over: Partial<MailMessage> = {}): MailMessage => ({
  id: '42',
  threadId: 't1',
  from: { name: 'Ana', address: 'ana@example.com' },
  to: [{ name: null, address: 'me@example.com' }, { name: 'Bo', address: 'bo@example.com' }],
  cc: [{ name: null, address: 'cy@example.com' }],
  replyTo: [],
  subject: 'Pricing question',
  snippet: '',
  date: '2026-11-10T09:00:00.000Z',
  seen: true,
  flagged: false,
  hasAttachments: false,
  messageId: '<m3@example.com>',
  inReplyTo: '<m2@example.com>',
  references: ['<m1@example.com>', '<m2@example.com>'],
  text: 'Hello\nHow much is it?',
  html: null,
  attachments: [],
  ...over,
});

describe('mail presets', () => {
  it('detects providers from the address domain', () => {
    expect(detectMailPreset('someone@gmail.com').id).toBe('gmail');
    expect(detectMailPreset('Someone@Hotmail.com').id).toBe('outlook');
    expect(detectMailPreset('x@icloud.com').config?.imap.host).toBe('imap.mail.me.com');
    expect(detectMailPreset('x@company.example').id).toBe('custom');
  });

  it('gives Gmail the app-password link and implicit TLS', () => {
    const gmail = detectMailPreset('a@gmail.com');
    expect(gmail.appPasswordUrl).toBe('https://myaccount.google.com/apppasswords');
    expect(gmail.config?.smtp).toEqual({ host: 'smtp.gmail.com', port: 465, secure: true });
    expect(gmail.config?.smtpSavesSent).toBe(true);
  });

  it('reads stored server config defensively', () => {
    expect(readImapSmtpConfig({ imap: { host: 'h', port: '993', secure: true }, smtp: { host: 's', port: 587 } })).toEqual({
      imap: { host: 'h', port: 993, secure: true },
      smtp: { host: 's', port: 587, secure: false },
    });
    expect(readImapSmtpConfig({ imap: { host: '', port: 993 } })).toBeNull();
  });
});

describe('reply building', () => {
  it('prefixes subjects once', () => {
    expect(replySubject('Hello')).toBe('Re: Hello');
    expect(replySubject('RE: Hello')).toBe('RE: Hello');
    expect(replySubject('Re[2]: Hello')).toBe('Re[2]: Hello');
    expect(forwardSubject('Hello')).toBe('Fwd: Hello');
    expect(forwardSubject('Fw: Hello')).toBe('Fw: Hello');
    expect(replySubject('')).toBe('Re: (no subject)');
  });

  it('extends the References chain with the original message id', () => {
    expect(buildReferences(original())).toEqual(['<m1@example.com>', '<m2@example.com>', '<m3@example.com>']);
    expect(buildReferences(original({ references: [] }))).toEqual(['<m2@example.com>', '<m3@example.com>']);
  });

  it('answers the sender, or everyone but us on reply-all', () => {
    expect(replyRecipients(original(), 'reply', 'me@example.com')).toEqual({ to: [{ name: 'Ana', address: 'ana@example.com' }], cc: [] });
    const all = replyRecipients(original(), 'replyAll', 'ME@example.com');
    expect(all.to.map((a) => a.address)).toEqual(['ana@example.com']);
    expect(all.cc.map((a) => a.address)).toEqual(['bo@example.com', 'cy@example.com']);
  });

  it('honours Reply-To over From', () => {
    const list = original({ replyTo: [{ name: 'List', address: 'list@example.com' }] });
    expect(replyRecipients(list, 'reply', 'me@example.com').to[0]?.address).toBe('list@example.com');
  });

  it('quotes the original and carries threading headers on replies only', () => {
    const reply = buildResponse({
      mode: 'reply',
      original: original(),
      from: { name: null, address: 'me@example.com' },
      to: [{ name: null, address: 'ana@example.com' }],
      cc: [],
      bcc: [],
      body: 'It is free.',
    });
    expect(reply.subject).toBe('Re: Pricing question');
    expect(reply.inReplyTo).toBe('<m3@example.com>');
    expect(reply.threadId).toBe('t1');
    expect(reply.text).toContain('> How much is it?');
    const forward = buildResponse({ ...{ mode: 'forward' as const }, original: original(), from: { name: null, address: 'me@example.com' }, to: [{ name: null, address: 'z@example.com' }], cc: [], bcc: [], body: 'FYI' });
    expect(forward.subject).toBe('Fwd: Pricing question');
    expect(forward.inReplyTo).toBeUndefined();
    expect(forward.text).toContain('Forwarded message');
  });
});

describe('recipient parsing', () => {
  it('accepts bare and named addresses, dedupes and reports invalid ones', () => {
    const parsed = parseRecipients('Ana <ana@example.com>, bo@example.com; "Cy D" <cy@example.com>, ana@example.com, not-an-email');
    expect(parsed.valid).toEqual([
      { name: 'Ana', address: 'ana@example.com' },
      { name: null, address: 'bo@example.com' },
      { name: 'Cy D', address: 'cy@example.com' },
    ]);
    expect(parsed.invalid).toEqual(['not-an-email']);
  });
});

describe('sanitizeEmailHtml', () => {
  it('strips scripts, handlers and forms, and hardens links', () => {
    const { html } = sanitizeEmailHtml(
      '<p onclick="steal()">Hi<script>alert(1)</script></p><form action="https://evil.example"><input name="pw"></form><a href="javascript:alert(1)">x</a><a href="https://ok.example">ok</a>',
    );
    expect(html).not.toMatch(/script|onclick|form|input|javascript:/i);
    expect(html).toContain('href="https://ok.example"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it('blocks remote images until asked, keeps inline ones', () => {
    const source = '<img src="https://tracker.example/p.gif"><img src="cid:logo">';
    const blocked = sanitizeEmailHtml(source);
    expect(blocked.blockedImages).toBe(1);
    expect(blocked.html).not.toContain('tracker.example');
    expect(blocked.html).toContain('cid:logo');
    const allowed = sanitizeEmailHtml(source, { allowRemoteImages: true });
    expect(allowed.blockedImages).toBe(0);
    expect(allowed.html).toContain('tracker.example');
  });

  it('drops dangerous inline styles', () => {
    const { html } = sanitizeEmailHtml('<div style="color:red;background:url(https://x.example/a.png);position:fixed">t</div>');
    expect(html).toContain('color:red');
    expect(html).not.toMatch(/url\(|position/);
  });
});

describe('parseRawMessage', () => {
  it('parses headers, threading and attachments from a MIME fixture', async () => {
    const raw = [
      'From: Ana <ana@example.com>',
      'To: me@example.com',
      'Cc: Bo <bo@example.com>',
      'Subject: =?UTF-8?Q?Presupuesto_r=C3=A1pido?=',
      'Date: Tue, 10 Nov 2026 09:00:00 +0000',
      'Message-ID: <m3@example.com>',
      'In-Reply-To: <m2@example.com>',
      'References: <m1@example.com> <m2@example.com>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="b1"',
      '',
      '--b1',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Hola, ¿cuánto cuesta?',
      '--b1',
      'Content-Type: application/pdf; name="quote.pdf"',
      'Content-Disposition: attachment; filename="quote.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      'JVBERi0xLjQK',
      '--b1--',
      '',
    ].join('\r\n');
    const message = await parseRawMessage(raw, { id: '7', threadId: null, seen: false, flagged: true });
    expect(message.subject).toBe('Presupuesto rápido');
    expect(message.from).toEqual({ name: 'Ana', address: 'ana@example.com' });
    expect(message.cc[0]?.address).toBe('bo@example.com');
    expect(message.references).toEqual(['<m1@example.com>', '<m2@example.com>']);
    expect(message.inReplyTo).toBe('<m2@example.com>');
    expect(message.text.trim()).toBe('Hola, ¿cuánto cuesta?');
    expect(message.attachments).toEqual([{ filename: 'quote.pdf', contentType: 'application/pdf', size: 9 }]);
    expect(message.hasAttachments).toBe(true);
    expect(message.date).toBe('2026-11-10T09:00:00.000Z');
  });
});
