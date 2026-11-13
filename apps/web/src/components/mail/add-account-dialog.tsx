'use client';

import { useEffect, useId, useState } from 'react';
import { ExternalLink, KeyRound, Mail } from 'lucide-react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
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
import { Switch } from '@/components/ui/switch';
import { apiGet, apiPost, ApiError } from '@/lib/api-client';
import { toast } from '@/components/ui/toast';
import type { MailAccountView } from './types';

/**
 * "Type your address, paste a password."
 *
 * The provider is detected from the domain; for the big ones the servers are filled in and the
 * dialog shows exactly where the app password is created. Saving logs in to both IMAP and SMTP
 * first, so a mailbox only appears in the list once it actually works.
 */

interface Detected {
  id: string;
  label: string;
  config: { imap: { host: string; port: number; secure: boolean }; smtp: { host: string; port: number; secure: boolean } } | null;
  appPasswordUrl: string | null;
  steps: string[];
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function AddAccountDialog({
  open,
  onOpenChange,
  initialEmail,
  gmailOAuthAvailable,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialEmail?: string;
  gmailOAuthAvailable: boolean;
  onSaved: (account: MailAccountView) => void;
}): React.JSX.Element {
  const ids = useId();
  const [email, setEmail] = useState(initialEmail ?? '');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [detected, setDetected] = useState<Detected | null>(null);
  const [custom, setCustom] = useState({ imapHost: '', imapPort: '993', smtpHost: '', smtpPort: '587', smtpSecure: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setEmail(initialEmail ?? '');
      setPassword('');
      setError(null);
    }
  }, [open, initialEmail]);

  // Detect the provider as the address is typed; a pure lookup on the server, no network.
  useEffect(() => {
    if (!EMAIL.test(email.trim())) {
      setDetected(null);
      return;
    }
    const handle = setTimeout(() => {
      apiGet<Detected>(`/api/mail/accounts/detect?email=${encodeURIComponent(email.trim())}`)
        .then(setDetected)
        .catch(() => setDetected(null));
    }, 250);
    return () => clearTimeout(handle);
  }, [email]);

  const needsServers = detected?.id === 'custom';
  const canSave = EMAIL.test(email.trim()) && password.trim().length > 0 && (!needsServers || (custom.imapHost && custom.smtpHost));

  async function save(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const result = await apiPost<{ account: MailAccountView; message: string }>('/api/mail/accounts', {
        email: email.trim(),
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
        password,
        ...(needsServers
          ? {
              imap: { host: custom.imapHost.trim(), port: Number(custom.imapPort), secure: Number(custom.imapPort) === 993 },
              smtp: { host: custom.smtpHost.trim(), port: Number(custom.smtpPort), secure: custom.smtpSecure },
            }
          : {}),
      });
      toast.success('Mailbox connected', { description: result.message });
      onSaved(result.account);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not connect this mailbox.');
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a mailbox</DialogTitle>
          <DialogDescription>
            Read, reply and send from here. Messages stay on your provider — the app fetches them when you look and
            never stores them.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[65vh] space-y-4 overflow-y-auto pr-1">
          <FormField label="Email address" htmlFor={`${ids}-email`} required>
            <Input
              id={`${ids}-email`}
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </FormField>

          {detected ? (
            <div className="space-y-3 rounded-md border border-border bg-muted/40 p-3 text-sm">
              <p className="flex items-center gap-2 font-medium text-foreground">
                <Mail aria-hidden="true" className="size-4" />
                {detected.label}
                {detected.config ? (
                  <span className="font-normal text-muted-foreground">
                    · {detected.config.imap.host} / {detected.config.smtp.host}
                  </span>
                ) : null}
              </p>
              <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
                {detected.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
              {detected.appPasswordUrl ? (
                <Button asChild size="sm" variant="secondary">
                  <a href={detected.appPasswordUrl} target="_blank" rel="noopener noreferrer">
                    <KeyRound aria-hidden="true" />
                    Create an app password
                    <ExternalLink aria-hidden="true" />
                  </a>
                </Button>
              ) : null}
              {detected.id === 'gmail' && gmailOAuthAvailable ? (
                <p className="text-xs text-muted-foreground">
                  Prefer not to use an app password?{' '}
                  <a className="text-primary hover:underline" href={`/api/mail/gmail/start?email=${encodeURIComponent(email.trim())}`}>
                    Sign in with Google instead
                  </a>
                  .
                </p>
              ) : null}
            </div>
          ) : null}

          {needsServers ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="IMAP server" htmlFor={`${ids}-imap`} required>
                <Input id={`${ids}-imap`} placeholder="imap.example.com" value={custom.imapHost} onChange={(event) => setCustom({ ...custom, imapHost: event.target.value })} />
              </FormField>
              <FormField label="IMAP port" htmlFor={`${ids}-imap-port`}>
                <Input id={`${ids}-imap-port`} inputMode="numeric" value={custom.imapPort} onChange={(event) => setCustom({ ...custom, imapPort: event.target.value })} />
              </FormField>
              <FormField label="SMTP server" htmlFor={`${ids}-smtp`} required>
                <Input id={`${ids}-smtp`} placeholder="smtp.example.com" value={custom.smtpHost} onChange={(event) => setCustom({ ...custom, smtpHost: event.target.value })} />
              </FormField>
              <FormField label="SMTP port" htmlFor={`${ids}-smtp-port`} description="587 uses STARTTLS; 465 is TLS.">
                <Input
                  id={`${ids}-smtp-port`}
                  inputMode="numeric"
                  value={custom.smtpPort}
                  onChange={(event) => setCustom({ ...custom, smtpPort: event.target.value, smtpSecure: event.target.value.trim() === '465' })}
                />
              </FormField>
              <label className="flex items-center gap-2 text-sm text-muted-foreground sm:col-span-2">
                <Switch checked={custom.smtpSecure} onCheckedChange={(checked) => setCustom({ ...custom, smtpSecure: checked })} />
                SMTP uses implicit TLS
              </label>
            </div>
          ) : null}

          <FormField
            label={detected?.appPasswordUrl ? 'App password' : 'Password'}
            htmlFor={`${ids}-password`}
            required
            description="Stored encrypted on this server and only used to talk to your provider."
          >
            <Input
              id={`${ids}-password`}
              type="password"
              autoComplete="new-password"
              placeholder={detected?.id === 'gmail' ? 'xxxx xxxx xxxx xxxx' : ''}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </FormField>

          <FormField label="Your name (optional)" htmlFor={`${ids}-name`} description="Shown to recipients in the From line.">
            <Input id={`${ids}-name`} value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          </FormField>

          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={!canSave} loading={pending} loadingText="Testing the connection">
            Test &amp; save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
