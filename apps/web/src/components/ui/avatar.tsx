'use client';

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn, colorIndex, initials } from '@/lib/utils';

const avatarVariants = cva(
  [
    'relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden',
    'border font-medium uppercase leading-none tracking-tight',
  ].join(' '),
  {
    variants: {
      size: {
        xs: 'size-5 rounded text-[0.625rem]',
        sm: 'size-6 rounded-sm text-2xs',
        md: 'size-8 rounded-md text-xs',
        lg: 'size-10 rounded-md text-sm',
      },
      shape: {
        square: '',
        circle: 'rounded-full',
      },
    },
    defaultVariants: {
      size: 'md',
      shape: 'square',
    },
  },
);

/**
 * Six tints. `colorIndex` hashes the name, so a site or teammate keeps the same
 * colour across sessions and machines — people scan long lists by colour, and a
 * colour that moves between renders is worse than no colour at all.
 *
 * Text uses `--tone-*` rather than `--chart-*`: the chart hues are calibrated for
 * filled marks and drop to ~2.5:1 at these sizes, which fails WCAG AA. The fill and
 * border stay on the chart palette so the identity still matches the charts.
 */
const AVATAR_TONES = [
  'border-chart-1/25 bg-chart-1/10 text-tone-1',
  'border-chart-2/25 bg-chart-2/10 text-tone-2',
  'border-chart-3/25 bg-chart-3/10 text-tone-3',
  'border-chart-4/25 bg-chart-4/10 text-tone-4',
  'border-chart-5/25 bg-chart-5/10 text-tone-5',
  'border-chart-6/25 bg-chart-6/10 text-tone-6',
] as const;

export interface AvatarProps
  extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'>,
    VariantProps<typeof avatarVariants> {
  /** Drives the initials, the deterministic colour and the default alt text. */
  name: string;
  /** Favicon, logo or profile picture. Falls back to initials if it fails to load. */
  src?: string | null;
  /** Overrides the default alt text when the image carries meaning of its own. */
  alt?: string;
}

/**
 * Initials-first avatar. The fallback is the primary state — most websites we
 * track have no usable logo — so initials are always rendered and the image is
 * layered over them, which also covers a transparent or slow-loading favicon.
 *
 * A plain `<img>` rather than `next/image`: sources are arbitrary third-party
 * hosts discovered at crawl time, which cannot be declared in `next.config`.
 */
const Avatar = React.forwardRef<HTMLSpanElement, AvatarProps>(function Avatar(
  { name, src, alt, size, shape, className, title, ...props },
  ref,
) {
  // Keyed by URL rather than a boolean so a new `src` retries automatically
  // without an effect resetting the flag.
  const [failedSrc, setFailedSrc] = React.useState<string | null>(null);
  const showImage = typeof src === 'string' && src.length > 0 && src !== failedSrc;
  const tone = AVATAR_TONES[colorIndex(name, AVATAR_TONES.length)];

  return (
    <span
      ref={ref}
      className={cn(avatarVariants({ size, shape }), tone, className)}
      title={title ?? name}
      {...props}
    >
      <span aria-hidden="true">{initials(name)}</span>
      {showImage ? (
        <img
          src={src}
          alt={alt ?? name}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailedSrc(src)}
          className="absolute inset-0 size-full object-cover"
        />
      ) : (
        <span className="sr-only">{alt ?? name}</span>
      )}
    </span>
  );
});

export { Avatar, avatarVariants };
