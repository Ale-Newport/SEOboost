/**
 * Barrel for the UI kit. Screens import from `@/components/ui`, never from the
 * individual files, so a component can be split or renamed without touching
 * every call site. Each module keeps its own `'use client'` boundary — this
 * file is a re-export only and adds none.
 */

export { Alert, AlertTitle, AlertDescription, alertVariants } from './alert';
export type { AlertProps } from './alert';

export { Avatar, avatarVariants } from './avatar';
export type { AvatarProps } from './avatar';

export { Badge, SeverityBadge, StatusBadge, badgeVariants, humanizeStatus } from './badge';
export type { BadgeProps, Severity, SeverityBadgeProps, StatusBadgeProps } from './badge';

export { Button, buttonVariants } from './button';
export type { ButtonProps } from './button';

export { Card, CardHeader, CardTitle, CardDescription, CardAction, CardContent, CardFooter } from './card';

export { Checkbox } from './checkbox';

export { ConfirmDialog, useConfirm } from './confirm-dialog';
export type { ConfirmDialogProps, ConfirmOptions, UseConfirmResult } from './confirm-dialog';

export { CopyButton } from './copy-button';
export type { CopyButtonProps } from './copy-button';

export { Delta, deltaVariants } from './delta';
export type { DeltaProps } from './delta';

export {
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from './dialog';
export type { DialogContentProps } from './dialog';

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuGroup,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuRadioGroup,
} from './dropdown-menu';

export { EmptyState, emptyStateVariants } from './empty-state';
export type { EmptyStateProps } from './empty-state';

export { ErrorState } from './error-state';
export type { ErrorStateProps } from './error-state';

export { FormField, useFormControl, useFormGroup } from './form-field';
export type { FormFieldProps } from './form-field';

export { Input, inputClassName } from './input';
export type { InputProps } from './input';

export { Label } from './label';

export { MetricCard } from './metric-card';
export type { MetricCardProps } from './metric-card';

export { PageHeader } from './page-header';
export type { PageHeaderProps } from './page-header';

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor, PopoverClose } from './popover';

export { Progress } from './progress';
export type { ProgressProps } from './progress';

export { ProgressBar } from './progress-bar';
export type { ProgressBarProps, ProgressBarSegment, ProgressTone } from './progress-bar';

export { RadioGroup, RadioGroupItem, RadioGroupOption } from './radio-group';
export type { RadioGroupProps, RadioGroupItemProps, RadioGroupOptionProps } from './radio-group';

export { ScoreBreakdown } from './score-breakdown';
export type { ScoreBreakdownProps, ScoreBreakdownSort } from './score-breakdown';

export {
  ScoreRing,
  scoreGrade,
  DEFAULT_SCORE_THRESHOLDS,
  SCORE_GRADE_STROKE,
  SCORE_GRADE_TEXT,
} from './score-ring';
export type { ScoreRingProps, ScoreGrade, ScoreThresholds } from './score-ring';

export { ScrollArea, ScrollBar } from './scroll-area';

export {
  Section,
  SectionHeader,
  SectionTitle,
  SectionDescription,
  SectionActions,
  SectionBody,
} from './section';
export type { SectionProps, SectionTitleProps } from './section';

export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectLabel,
  SelectItem,
  SelectSeparator,
  SelectScrollUpButton,
  SelectScrollDownButton,
} from './select';

export { Separator } from './separator';

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetPortal,
  SheetOverlay,
  SheetContent,
  SheetHeader,
  SheetBody,
  SheetFooter,
  SheetTitle,
  SheetDescription,
} from './sheet';
export type { SheetContentProps } from './sheet';

export { Skeleton, SkeletonText, SkeletonCard, SkeletonTable } from './skeleton';
export type { SkeletonProps, SkeletonTextProps, SkeletonCardProps, SkeletonTableProps } from './skeleton';

export { StatList, StatListItem } from './stat-list';
export type { StatListProps, StatListItemProps } from './stat-list';

export { Switch } from './switch';

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants, tabsTriggerVariants } from './tabs';

export { Textarea } from './textarea';
export type { TextareaProps } from './textarea';

export { ThemeToggle } from './theme-toggle';
export type { ThemeToggleProps } from './theme-toggle';

export { Toaster, toast } from './toast';
export type { ToasterProps } from './toast';

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider, TooltipPortal, SimpleTooltip } from './tooltip';
export type { SimpleTooltipProps } from './tooltip';

export { TooltipInfo } from './tooltip-info';
export type { TooltipInfoProps } from './tooltip-info';
