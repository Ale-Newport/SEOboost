import { Badge } from '@/components/ui/badge';
import { SimpleTooltip } from '@/components/ui/tooltip';
import {
  CONVERSATION_STATUS_META,
  PLATFORM_LABEL,
  POLICY_META,
  POST_STATUS_META,
} from './format';
import type { ConversationStatusValue, PolicyValue, PostStatusValue, SocialPlatformValue } from './types';

/** Small, repeated labels. A policy badge always carries its meaning on hover — a colour alone is not a rule. */

export function PlatformBadge({ platform }: { platform: SocialPlatformValue }): React.JSX.Element {
  return (
    <Badge variant="outline" className="font-normal">
      {PLATFORM_LABEL[platform]}
    </Badge>
  );
}

export function PolicyBadge({ policy, summary }: { policy: PolicyValue; summary?: string | null }): React.JSX.Element {
  const meta = POLICY_META[policy];
  return (
    <SimpleTooltip content={<span className="block max-w-xs">{summary || meta.description}</span>}>
      <Badge variant={meta.variant} className="cursor-help font-normal">
        {meta.label}
      </Badge>
    </SimpleTooltip>
  );
}

export function ConversationStatusBadge({ status }: { status: ConversationStatusValue }): React.JSX.Element {
  const meta = CONVERSATION_STATUS_META[status];
  return <Badge variant={meta.variant}>{meta.label}</Badge>;
}

export function PostStatusBadge({ status }: { status: PostStatusValue }): React.JSX.Element {
  const meta = POST_STATUS_META[status];
  return <Badge variant={meta.variant}>{meta.label}</Badge>;
}
