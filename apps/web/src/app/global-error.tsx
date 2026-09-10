'use client';

import * as React from 'react';

/**
 * Last-resort error boundary.
 *
 * `app/error.tsx` sits *inside* the root layout, so it cannot catch a failure in the root layout
 * itself (or in the theme provider it mounts). This one replaces the whole document, which is
 * why it renders its own `<html>`/`<body>` and why every style here is inline: the design tokens
 * live in `globals.css`, which the root layout imports — and the root layout is precisely what
 * has just failed. A stylesheet-less fallback is the only one guaranteed to render.
 *
 * As in `error.tsx`, the thrown value is never shown. `digest` is the server-generated id that
 * ties this screen to the matching server log line; the full error goes to the console.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    console.error('Unhandled error in the root layout', error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '2rem 1rem',
          background: 'Canvas',
          color: 'CanvasText',
          colorScheme: 'light dark',
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
        }}
      >
        <main style={{ maxWidth: '28rem', width: '100%' }}>
          <h1 style={{ fontSize: '1rem', fontWeight: 600, margin: '0 0 0.5rem', lineHeight: 1.3 }}>
            The application failed to start
          </h1>
          <p style={{ fontSize: '0.875rem', lineHeight: 1.6, margin: '0 0 1rem', opacity: 0.75 }}>
            Something went wrong before the interface could be rendered. Nothing was changed, and
            reloading is safe. If it keeps happening, the server log has the details.
          </p>

          {error.digest ? (
            <p style={{ fontSize: '0.75rem', lineHeight: 1.6, margin: '0 0 1.25rem', opacity: 0.75 }}>
              Reference{' '}
              <code style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                {error.digest}
              </code>
            </p>
          ) : (
            <p style={{ fontSize: '0.75rem', lineHeight: 1.6, margin: '0 0 1.25rem', opacity: 0.75 }}>
              Details were written to the server log.
            </p>
          )}

          <button
            type="button"
            onClick={() => reset()}
            style={{
              font: 'inherit',
              fontSize: '0.875rem',
              fontWeight: 500,
              padding: '0.5rem 0.9rem',
              borderRadius: '0.375rem',
              border: '1px solid currentColor',
              background: 'transparent',
              color: 'inherit',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
