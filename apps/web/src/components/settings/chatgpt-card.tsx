'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ExternalLink, Loader2, LogOut, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { apiDelete, apiPost, ApiError } from '@/lib/api-client';
import type { ChatGptConnectionInfo } from './types';

/**
 * "Sign in with ChatGPT" — the user's own ChatGPT Plus/Pro plan as the AI provider.
 *
 * The button is a plain navigation to `/api/ai/chatgpt/start`, which redirects to OpenAI; the
 * sign-in comes back through a loopback callback and lands here again with `?ai=…`. Copy follows
 * OpenAI's UI guidelines: the button says exactly "Sign in with ChatGPT", and a "Manage usage"
 * link always sits next to a connected plan.
 */
export function ChatGptCard({ chatgpt, canAdminister }: { chatgpt: ChatGptConnectionInfo; canAdminister: boolean }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [busy, setBusy] = useState<'refresh' | 'disconnect' | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Report the outcome of a sign-in once, then drop the parameters from the URL.
  useEffect(() => {
    const outcome = searchParams.get('ai');
    if (!outcome?.startsWith('chatgpt-')) return;
    if (outcome === 'chatgpt-connected') toast.success('ChatGPT connected — AI features now use your plan.');
    else toast.error(searchParams.get('reason') ?? 'The ChatGPT sign-in did not complete.');
    router.replace('/settings');
  }, [searchParams, router]);

  const refreshModels = async () => {
    setBusy('refresh');
    try {
      await apiPost('/api/ai/chatgpt/refresh-models', {});
      toast.success('Model list refreshed');
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not refresh the model list');
    } finally {
      setBusy(null);
    }
  };

  // Throws on failure so the confirmation stays open with the message (ConfirmDialog awaits it).
  const disconnect = async () => {
    setBusy('disconnect');
    try {
      await apiDelete('/api/ai/chatgpt');
      toast.success('ChatGPT disconnected');
      router.refresh();
    } finally {
      setBusy(null);
    }
  };

  const status = chatgpt.connected ? 'connected' : chatgpt.needsReauth ? 'sign in again' : 'not connected';
  const variant = chatgpt.connected ? 'success' : chatgpt.needsReauth ? 'warning' : 'secondary';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">ChatGPT plan</CardTitle>
        <CardAction>
          <Badge variant={variant} className="text-2xs">{status}</Badge>
        </CardAction>
        <CardDescription className="text-xs">
          Use your own ChatGPT Plus or Pro subscription for every AI feature — agents, content, social
          replies — instead of an API key. Usage counts against your plan and the weekly cap you set
          for this app in ChatGPT; nothing is billed to an API account.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        {chatgpt.connected ? (
          <>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
              <dt className="text-muted-foreground">Account</dt>
              <dd className="truncate font-medium">{chatgpt.email ?? chatgpt.name ?? 'ChatGPT account'}</dd>
              <dt className="text-muted-foreground">Models</dt>
              <dd className="min-w-0">
                {chatgpt.models.length ? (
                  <span className="flex flex-wrap gap-1">
                    {chatgpt.models.map((model, index) => (
                      <Badge key={model.slug} variant={index === 0 ? 'secondary' : 'outline'} className="font-mono text-2xs font-normal">
                        {model.displayName}
                      </Badge>
                    ))}
                  </span>
                ) : (
                  <span className="text-muted-foreground">None listed yet — refresh the list.</span>
                )}
              </dd>
            </dl>
            {chatgpt.lastError && (
              <Alert variant="warning" title="Last problem">
                {chatgpt.lastError}
              </Alert>
            )}
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline" size="sm">
                <a href={chatgpt.manageUsageUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink aria-hidden="true" />
                  Manage usage
                </a>
              </Button>
              <Button variant="outline" size="sm" onClick={() => void refreshModels()} disabled={busy !== null}>
                {busy === 'refresh' ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
                Refresh models
              </Button>
              {canAdminister && (
                <Button variant="ghost" size="sm" onClick={() => setConfirmOpen(true)} disabled={busy !== null}>
                  <LogOut aria-hidden="true" />
                  Disconnect
                </Button>
              )}
            </div>
          </>
        ) : (
          <>
            {chatgpt.needsReauth && chatgpt.lastError && (
              <Alert variant="warning" title="Sign in again">
                {chatgpt.lastError}
              </Alert>
            )}
            {!chatgpt.needsReauth && chatgpt.lastError && (
              <Alert variant="warning" title="The last sign-in did not enable plan usage">
                {chatgpt.lastError}
              </Alert>
            )}
            <p className="text-muted-foreground">
              Needs ChatGPT Plus or Pro (free accounts can sign in but cannot use their plan in other
              apps). You will be asked on chatgpt.com to allow this app to use your plan; you can cap
              its share of your weekly usage there at any time.
            </p>
            {canAdminister ? (
              <Button asChild size="sm">
                {/* A navigation, not a fetch: the route answers with a redirect to OpenAI. */}
                <a href="/api/ai/chatgpt/start">Sign in with ChatGPT</a>
              </Button>
            ) : (
              <p className="text-muted-foreground">Only the owner or an admin can connect ChatGPT.</p>
            )}
          </>
        )}
      </CardContent>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Disconnect ChatGPT?"
        description="AI features will fall back to an API key if one is configured, or stop until you sign in again. You can reconnect the same account later."
        confirmLabel="Disconnect"
        destructive
        onConfirm={disconnect}
      />
    </Card>
  );
}
