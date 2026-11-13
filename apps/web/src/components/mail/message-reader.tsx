'use client';

import { useMemo } from 'react';
import { Archive, ArrowLeft, Forward, ImageIcon, MailOpen, Paperclip, Reply, ReplyAll, Star, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { displayName, formatAddressView, type ComposeMode, type MailMessageView } from './types';

/**
 * The reading pane.
 *
 * HTML arrives already sanitized, and is still rendered in an iframe with an empty `sandbox`
 * (no scripts, no same-origin, no forms, no top navigation): if the sanitizer ever misses
 * something, the message still cannot touch the app or its session. Links open in a new tab.
 */

const DATE = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function frameDocument(html: string, dark: boolean): string {
  return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>
    body{margin:0;padding:16px;font:14px/1.55 system-ui,-apple-system,sans-serif;color:${dark ? '#e5e7eb' : '#111827'};background:transparent;word-wrap:break-word}
    img{max-width:100%;height:auto} a{color:${dark ? '#93c5fd' : '#2563eb'}} blockquote{margin:0 0 0 .8em;padding-left:.8em;border-left:2px solid #9ca3af66}
    table{max-width:100%}
  </style></head><body>${html}</body></html>`;
}

export function MessageReader({
  message,
  blockedImages,
  loading,
  onBack,
  onCompose,
  onArchive,
  onTrash,
  onToggleSeen,
  onToggleFlag,
  onLoadImages,
}: {
  message: MailMessageView | null;
  blockedImages: number;
  loading: boolean;
  onBack: () => void;
  onCompose: (mode: Exclude<ComposeMode, 'new'>) => void;
  onArchive: () => void;
  onTrash: () => void;
  onToggleSeen: () => void;
  onToggleFlag: () => void;
  onLoadImages: () => void;
}): React.JSX.Element {
  const dark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
  const srcDoc = useMemo(() => (message?.html ? frameDocument(message.html, dark) : null), [message?.html, dark]);

  if (!message) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        {loading ? 'Opening the message…' : 'Select a message to read it.'}
      </div>
    );
  }

  const action = (label: string, icon: React.ReactNode, onClick: () => void) => (
    <SimpleTooltip content={label}>
      <Button variant="ghost" size="icon" aria-label={label} onClick={onClick}>
        {icon}
      </Button>
    </SimpleTooltip>
  );

  return (
    <article className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-1.5">
        <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Back to the list" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
        </Button>
        {action('Reply', <Reply aria-hidden="true" />, () => onCompose('reply'))}
        {action('Reply all', <ReplyAll aria-hidden="true" />, () => onCompose('replyAll'))}
        {action('Forward', <Forward aria-hidden="true" />, () => onCompose('forward'))}
        <Separator orientation="vertical" className="mx-1 h-5" />
        {action('Archive', <Archive aria-hidden="true" />, onArchive)}
        {action('Move to Trash', <Trash2 aria-hidden="true" />, onTrash)}
        {action('Mark as unread', <MailOpen aria-hidden="true" />, onToggleSeen)}
        {action(message.flagged ? 'Remove star' : 'Star', <Star aria-hidden="true" className={message.flagged ? 'fill-current text-warning' : ''} />, onToggleFlag)}
      </div>

      <header className="space-y-1 px-4 pb-3 pt-4">
        <h2 className="text-lg font-semibold leading-snug text-foreground">{message.subject || '(no subject)'}</h2>
        <p className="text-sm text-foreground">
          {displayName(message.from)}{' '}
          {message.from?.name ? <span className="text-muted-foreground">&lt;{message.from.address}&gt;</span> : null}
        </p>
        <p className="text-xs text-muted-foreground">
          To {message.to.map(formatAddressView).join(', ') || '—'}
          {message.cc.length ? ` · Cc ${message.cc.map(formatAddressView).join(', ')}` : ''}
          {message.date ? ` · ${DATE.format(new Date(message.date))}` : ''}
        </p>
      </header>

      {blockedImages > 0 ? (
        <div className="mx-4 mb-2 flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <ImageIcon aria-hidden="true" className="size-4" />
          {blockedImages} remote {blockedImages === 1 ? 'image was' : 'images were'} blocked so the sender cannot tell you opened this.
          <Button size="sm" variant="secondary" onClick={onLoadImages}>
            Load images
          </Button>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto">
        {srcDoc ? (
          <iframe title="Message content" sandbox="" srcDoc={srcDoc} className="h-full min-h-[400px] w-full border-0" />
        ) : (
          <pre className="whitespace-pre-wrap break-words px-4 pb-6 font-sans text-sm text-foreground">{message.text || '(empty message)'}</pre>
        )}
      </div>

      {message.attachments.length ? (
        <footer className="border-t border-border px-4 py-2">
          <ul className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            {message.attachments.map((attachment, index) => (
              <li key={`${attachment.filename}-${index}`} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1">
                <Paperclip aria-hidden="true" className="size-3" />
                {attachment.filename} · {Math.max(1, Math.round(attachment.size / 1024))} KB
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[11px] text-muted-foreground">Open your mail provider to download attachments.</p>
        </footer>
      ) : null}
    </article>
  );
}
