'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import { Paperclip, Send, X } from 'lucide-react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { apiPost, ApiError } from '@/lib/api-client';
import { formatAddressView, type ComposeTarget, type MailAccountView, type MailAddressView } from './types';

/**
 * Compose, reply, reply-all and forward.
 *
 * Recipients are pre-filled the way every mail client does (Reply-To over From; reply-all minus
 * yourself) but stay editable. Sending is this one button; above ten recipients it asks first,
 * and the server refuses the same request without that confirmation.
 */

const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const BULK_THRESHOLD = 10;
const ADDRESS = /^[^\s@<>(),;:"[\]]+@[^\s@<>(),;:"[\]]+\.[^\s@<>(),;:"[\]]{2,}$/;

function parse(input: string): { valid: MailAddressView[]; invalid: string[] } {
  const valid: MailAddressView[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.split(/[,;\n]/)) {
    const part = raw.trim();
    if (!part) continue;
    const angled = part.match(/^(.*?)\s*<([^>]+)>$/);
    const address = (angled ? angled[2]! : part).trim();
    if (!ADDRESS.test(address)) {
      invalid.push(part);
      continue;
    }
    if (seen.has(address.toLowerCase())) continue;
    seen.add(address.toLowerCase());
    valid.push({ name: angled ? angled[1]!.replace(/^"|"$/g, '').trim() || null : null, address });
  }
  return { valid, invalid };
}

function defaults(target: ComposeTarget, self: string): { to: string; cc: string; subject: string } {
  const original = target.original?.message;
  if (!original || target.mode === 'new') return { to: '', cc: '', subject: '' };
  const me = self.toLowerCase();
  const base = original.subject.trim() || '(no subject)';
  if (target.mode === 'forward') return { to: '', cc: '', subject: /^\s*(fwd?|fw)\s*:/i.test(base) ? base : `Fwd: ${base}` };
  const subject = /^\s*re\s*(\[\d+\])?\s*:/i.test(base) ? base : `Re: ${base}`;
  const primary = (original.replyTo.length ? original.replyTo : original.from ? [original.from] : []).filter(
    (address) => address.address.toLowerCase() !== me,
  );
  if (target.mode === 'reply') return { to: primary.map(formatAddressView).join(', '), cc: '', subject };
  const taken = new Set([...primary.map((address) => address.address.toLowerCase()), me]);
  const cc = [...original.to, ...original.cc].filter((address) => {
    const key = address.address.toLowerCase();
    if (taken.has(key)) return false;
    taken.add(key);
    return true;
  });
  return { to: primary.map(formatAddressView).join(', '), cc: cc.map(formatAddressView).join(', '), subject };
}

async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function ComposeDialog({
  target,
  accounts,
  defaultAccountId,
  onClose,
  onSent,
}: {
  target: ComposeTarget | null;
  accounts: MailAccountView[];
  defaultAccountId: string | null;
  onClose: () => void;
  onSent: () => void;
}): React.JSX.Element {
  const ids = useId();
  const { confirm, confirmDialog } = useConfirm();
  const [accountId, setAccountId] = useState(defaultAccountId ?? accounts[0]?.id ?? '');
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [bcc, setBcc] = useState('');
  const [showCopies, setShowCopies] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const account = accounts.find((row) => row.id === accountId) ?? null;

  useEffect(() => {
    if (!target) return;
    const sender = defaultAccountId ?? accounts[0]?.id ?? '';
    setAccountId(sender);
    const self = accounts.find((row) => row.id === sender)?.email ?? '';
    const prefill = defaults(target, self);
    setTo(prefill.to);
    setCc(prefill.cc);
    setBcc('');
    setShowCopies(Boolean(prefill.cc));
    setSubject(prefill.subject);
    setBody('');
    setFiles([]);
    setError(null);
    // Reset only when a different compose target opens; account list changes must not wipe a draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const parsed = useMemo(() => ({ to: parse(to), cc: parse(cc), bcc: parse(bcc) }), [to, cc, bcc]);
  const invalid = [...parsed.to.invalid, ...parsed.cc.invalid, ...parsed.bcc.invalid];
  const recipients = parsed.to.valid.length + parsed.cc.valid.length + parsed.bcc.valid.length;
  const attachmentBytes = files.reduce((total, file) => total + file.size, 0);
  const canSend = Boolean(account) && recipients > 0 && invalid.length === 0 && attachmentBytes <= MAX_ATTACHMENT_BYTES && (body.trim() || target?.mode === 'forward');

  async function send(): Promise<void> {
    if (!account || !target) return;
    let confirmedBulk = false;
    if (recipients > BULK_THRESHOLD) {
      confirmedBulk = await confirm({
        title: `Send to ${recipients} people?`,
        description: 'This message goes to more than ten recipients. Make sure every one of them expects it.',
        confirmLabel: `Send to ${recipients}`,
      });
      if (!confirmedBulk) return;
    }
    setPending(true);
    setError(null);
    try {
      await apiPost(`/api/mail/accounts/${account.id}/send`, {
        mode: target.mode,
        to: parsed.to.valid,
        cc: parsed.cc.valid,
        bcc: parsed.bcc.valid,
        subject,
        body,
        ...(target.original && target.mode !== 'new'
          ? { original: { folder: target.original.folder, id: target.original.message.id } }
          : {}),
        attachments: await Promise.all(
          files.map(async (file) => ({ filename: file.name, contentType: file.type || 'application/octet-stream', contentBase64: await toBase64(file) })),
        ),
        confirmedBulk,
      });
      toast.success('Sent', { description: `From ${account.email}` });
      onSent();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The message could not be sent.');
    } finally {
      setPending(false);
    }
  }

  const heading =
    target?.mode === 'reply' ? 'Reply' : target?.mode === 'replyAll' ? 'Reply all' : target?.mode === 'forward' ? 'Forward' : 'New message';

  return (
    <>
      {confirmDialog}
      <Dialog open={target !== null} onOpenChange={(open) => (open ? null : onClose())}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{heading}</DialogTitle>
            <DialogDescription>
              {target?.original ? `Re: “${target.original.message.subject || '(no subject)'}” — the original is quoted below your text.` : 'Sent from your own mailbox, with your own address.'}
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[62vh] space-y-3 overflow-y-auto pr-1">
            <FormField label="From" htmlFor={`${ids}-from`}>
              <Select value={accountId} onValueChange={setAccountId}>
                <SelectTrigger id={`${ids}-from`} aria-label="From">
                  <SelectValue placeholder="Choose a mailbox" />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((row) => (
                    <SelectItem key={row.id} value={row.id}>
                      {row.displayName ? `${row.displayName} <${row.email}>` : row.email}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField label="To" htmlFor={`${ids}-to`} required description="Separate addresses with commas.">
              <div className="flex gap-2">
                <Input id={`${ids}-to`} value={to} onChange={(event) => setTo(event.target.value)} placeholder="name@example.com" />
                {!showCopies ? (
                  <Button variant="ghost" size="sm" onClick={() => setShowCopies(true)}>
                    Cc/Bcc
                  </Button>
                ) : null}
              </div>
            </FormField>
            {showCopies ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField label="Cc" htmlFor={`${ids}-cc`}>
                  <Input id={`${ids}-cc`} value={cc} onChange={(event) => setCc(event.target.value)} />
                </FormField>
                <FormField label="Bcc" htmlFor={`${ids}-bcc`}>
                  <Input id={`${ids}-bcc`} value={bcc} onChange={(event) => setBcc(event.target.value)} />
                </FormField>
              </div>
            ) : null}
            {invalid.length ? (
              <p className="text-xs text-destructive">Not a valid address: {invalid.join(', ')}</p>
            ) : null}
            <FormField label="Subject" htmlFor={`${ids}-subject`}>
              <Input id={`${ids}-subject`} value={subject} onChange={(event) => setSubject(event.target.value)} />
            </FormField>
            <FormField label="Message" htmlFor={`${ids}-body`} required={target?.mode !== 'forward'}>
              <Textarea id={`${ids}-body`} rows={10} value={body} onChange={(event) => setBody(event.target.value)} />
            </FormField>
            {account?.signature ? <p className="text-xs text-muted-foreground">Your signature is added at the end.</p> : null}

            <div className="space-y-2">
              <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-primary hover:underline">
                <Paperclip aria-hidden="true" className="size-4" />
                Attach files
                <input
                  type="file"
                  multiple
                  className="sr-only"
                  onChange={(event) => {
                    const picked = Array.from(event.target.files ?? []);
                    setFiles((current) => [...current, ...picked].slice(0, 10));
                    event.target.value = '';
                  }}
                />
              </label>
              {files.length ? (
                <ul className="flex flex-wrap gap-2">
                  {files.map((file, index) => (
                    <li key={`${file.name}-${index}`} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs">
                      {file.name} · {Math.max(1, Math.round(file.size / 1024))} KB
                      <button
                        type="button"
                        aria-label={`Remove ${file.name}`}
                        className="text-muted-foreground hover:text-foreground"
                        onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}
                      >
                        <X aria-hidden="true" className="size-3" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {attachmentBytes > MAX_ATTACHMENT_BYTES ? <p className="text-xs text-destructive">Attachments are limited to 15 MB in total.</p> : null}
            </div>

            {error ? (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>
              Discard
            </Button>
            <Button onClick={() => void send()} disabled={!canSend} loading={pending} loadingText="Sending">
              <Send aria-hidden="true" />
              Send
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
