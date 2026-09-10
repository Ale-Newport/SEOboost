import type { CSSProperties } from 'react';
import { redirect } from 'next/navigation';
import { Radar } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth';

/**
 * Auth shell.
 *
 * Session state decides whether these routes may render at all, so the segment opts out of
 * static rendering — a cached "signed out" page served to a signed-in operator would bounce
 * them through a pointless redirect on every visit.
 */
export const dynamic = 'force-dynamic';

/**
 * The grid is painted with `hsl(var(--border))` and the glow with `hsl(var(--primary))` so a
 * theme switch re-tints the backdrop without a second set of rules.
 */
const GRID_STYLE: CSSProperties = {
  backgroundImage: [
    'linear-gradient(to right, hsl(var(--border)) 1px, transparent 1px)',
    'linear-gradient(to bottom, hsl(var(--border)) 1px, transparent 1px)',
  ].join(','),
  backgroundSize: '48px 48px',
  maskImage: 'radial-gradient(ellipse 65% 55% at 50% 30%, #000 10%, transparent 72%)',
  WebkitMaskImage: 'radial-gradient(ellipse 65% 55% at 50% 30%, #000 10%, transparent 72%)',
};

const GLOW_STYLE: CSSProperties = {
  backgroundImage:
    'radial-gradient(ellipse 55% 45% at 50% 0%, hsl(var(--primary) / 0.16), transparent 70%)',
};

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  // Signing in twice is never what someone wants; send them where they were going.
  if (await getCurrentUser()) redirect('/');

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-4 py-12">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 opacity-70 dark:opacity-40" style={GRID_STYLE} />
        <div className="absolute inset-x-0 top-0 h-[32rem]" style={GLOW_STYLE} />
      </div>

      <main className="relative z-10 w-full max-w-[26rem]">
        <div className="mb-7 flex flex-col items-center gap-3 text-center">
          <span className="flex size-11 items-center justify-center rounded-xl border border-border bg-card shadow-card">
            <Radar className="size-5 text-primary" aria-hidden="true" />
          </span>
          <div className="space-y-1.5">
            <span className="block text-sm font-semibold tracking-tight text-foreground">SEO OS</span>
            <p className="text-sm leading-relaxed text-muted-foreground">
              One control center for technical SEO, content and AI-search visibility across every site
              you run.
            </p>
          </div>
        </div>

        {children}
      </main>

      <p className="relative z-10 mt-8 max-w-[26rem] text-center text-2xs leading-relaxed text-muted-foreground">
        Self-hosted. Crawl data, API keys and integration credentials stay inside this installation.
      </p>
    </div>
  );
}
