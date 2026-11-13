'use client';

import { useEffect } from 'react';
import { toast } from 'sonner';

/** `2026-11-13T…` → "13 Nov 2026"; null-safe for optional API dates. */
export function shortDate(value: string | null): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(new Date(value));
}

export function relativeAge(value: string | null): string {
  if (!value) return '';
  const hours = (Date.now() - new Date(value).getTime()) / 3_600_000;
  if (hours < 1) return 'just now';
  if (hours < 24) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * The OAuth callbacks send the browser back with `linked` or `error`; announce it once and drop
 * the parameters so a reload does not repeat the toast.
 */
export function useLinkFlash(onLinked?: () => void): void {
  useEffect(() => {
    const url = new URL(window.location.href);
    const linked = url.searchParams.get('linked');
    const error = url.searchParams.get('error');
    const handle = url.searchParams.get('handle');
    if (!linked && !error) return;
    if (linked) {
      toast.success(`${linked === 'github' ? 'GitHub' : 'Reddit'} linked${handle ? ` as ${handle}` : ''}`);
      onLinked?.();
    }
    if (error) toast.error('Linking not completed', { description: error, duration: 12_000 });
    for (const key of ['linked', 'error', 'handle']) url.searchParams.delete(key);
    window.history.replaceState(null, '', url.toString());
  }, [onLinked]);
}

/** Styled native select — enough for a short list of sites or sort orders. */
export function NativeSelect(props: React.SelectHTMLAttributes<HTMLSelectElement>): React.JSX.Element {
  return (
    <select
      {...props}
      className={`h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${props.className ?? ''}`}
    />
  );
}

/** Rendered GitHub HTML (already sanitised server-side), styled like the app's prose. */
export function GitHubHtml({ html }: { html: string }): React.JSX.Element {
  return (
    <div
      className="prose prose-sm max-w-none break-words text-foreground dark:prose-invert [&_a]:text-primary [&_img]:inline [&_img]:max-w-full [&_pre]:overflow-x-auto [&_table]:block [&_table]:overflow-x-auto"
      // The HTML is GitHub's own rendering, sanitised again by `sanitizeGitHubHtml` before it left the server.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
