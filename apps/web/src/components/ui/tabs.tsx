'use client';

import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const Tabs = TabsPrimitive.Root;

const tabsListVariants = cva('inline-flex items-center', {
  variants: {
    variant: {
      /** Underlined tabs — the default for page-level navigation. */
      line: 'h-9 w-full justify-start gap-4 border-b border-border',
      /** Contained pills — for switching a view inside a card. */
      pill: 'h-8 gap-1 rounded-md bg-muted p-0.5',
    },
  },
  defaultVariants: {
    variant: 'line',
  },
});

const tabsTriggerVariants = cva(
  [
    'inline-flex items-center justify-center gap-1.5 whitespace-nowrap text-sm font-medium transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
    'disabled:pointer-events-none disabled:opacity-50',
    '[&_svg]:size-4 [&_svg]:shrink-0',
  ].join(' '),
  {
    variants: {
      variant: {
        line: [
          '-mb-px h-9 border-b-2 border-transparent px-0.5 pb-2 pt-1.5 text-muted-foreground',
          'hover:text-foreground',
          'data-[state=active]:border-primary data-[state=active]:text-foreground',
        ].join(' '),
        pill: [
          'h-7 rounded-[5px] px-2.5 text-muted-foreground',
          'hover:text-foreground',
          'data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-xs',
        ].join(' '),
      },
    },
    defaultVariants: {
      variant: 'line',
    },
  },
);

type TabsVariant = NonNullable<VariantProps<typeof tabsListVariants>['variant']>;

/** Lets `TabsTrigger` inherit the list's variant instead of repeating it on every tab. */
const TabsVariantContext = React.createContext<TabsVariant>('line');

const TabsList = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> & VariantProps<typeof tabsListVariants>
>(function TabsList({ className, variant, ...props }, ref) {
  const resolved: TabsVariant = variant ?? 'line';
  return (
    <TabsVariantContext.Provider value={resolved}>
      <TabsPrimitive.List ref={ref} className={cn(tabsListVariants({ variant: resolved }), className)} {...props} />
    </TabsVariantContext.Provider>
  );
});

const TabsTrigger = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(function TabsTrigger({ className, ...props }, ref) {
  const variant = React.useContext(TabsVariantContext);
  return <TabsPrimitive.Trigger ref={ref} className={cn(tabsTriggerVariants({ variant }), className)} {...props} />;
});

const TabsContent = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(function TabsContent({ className, ...props }, ref) {
  return (
    <TabsPrimitive.Content
      ref={ref}
      className={cn(
        'mt-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        className,
      )}
      {...props}
    />
  );
});

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants, tabsTriggerVariants };
