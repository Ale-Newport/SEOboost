'use client';

import * as React from 'react';
import { useTheme } from 'next-themes';
import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from './button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from './dropdown-menu';

type ThemeChoice = 'light' | 'dark' | 'system';

const THEME_OPTIONS: ReadonlyArray<{ value: ThemeChoice; label: string; icon: LucideIcon }> = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

function iconFor(choice: ThemeChoice): LucideIcon {
  return THEME_OPTIONS.find((option) => option.value === choice)?.icon ?? Monitor;
}

export interface ThemeToggleProps {
  align?: 'start' | 'center' | 'end';
  /** Show the current theme's name beside the icon — for settings pages and wide menus. */
  showLabel?: boolean;
  className?: string;
}

/**
 * Light / dark / system switch.
 *
 * The stored preference is unknown during SSR and on the first client render,
 * so until `mounted` flips this renders a disabled placeholder with identical
 * markup. Rendering the real icon straight away would either mismatch the
 * server HTML or flash the wrong icon on every page load.
 */
function ThemeToggle({ align = 'end', showLabel = false, className }: ThemeToggleProps): React.JSX.Element {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  const current: ThemeChoice =
    theme === 'light' || theme === 'dark' || theme === 'system' ? theme : 'system';
  const CurrentIcon = mounted ? iconFor(current) : Monitor;
  const currentLabel = THEME_OPTIONS.find((option) => option.value === current)?.label ?? 'System';

  if (!mounted) {
    return (
      <Button
        variant="ghost"
        size={showLabel ? 'sm' : 'icon'}
        disabled
        aria-hidden="true"
        tabIndex={-1}
        className={cn('text-muted-foreground', className)}
      >
        <CurrentIcon aria-hidden="true" />
        {showLabel ? <span>Theme</span> : null}
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size={showLabel ? 'sm' : 'icon'}
          aria-label={showLabel ? undefined : `Theme: ${currentLabel}`}
          className={cn('text-muted-foreground hover:text-foreground', className)}
        >
          <CurrentIcon aria-hidden="true" />
          {showLabel ? <span>{currentLabel}</span> : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="min-w-[8.5rem]">
        <DropdownMenuRadioGroup value={current} onValueChange={(value) => setTheme(value)}>
          {THEME_OPTIONS.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              <option.icon aria-hidden="true" />
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export { ThemeToggle };
