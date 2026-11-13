/**
 * Wire types for the Accounts area. Client-safe: mirrors what `/api/accounts/**` returns, so
 * client components never import a server package.
 */

export type PersonalProviderValue = 'GITHUB' | 'REDDIT';

export interface PersonalAccountWire {
  id: string;
  provider: PersonalProviderValue;
  handle: string | null;
  displayName: string | null;
  email: string | null;
  status: 'NOT_CONFIGURED' | 'CONNECTED' | 'ERROR' | 'EXPIRED' | 'DISABLED';
  linkedVia: string | null;
  lastUsedAt: string | null;
  lastError: string | null;
  updatedAt: string;
}

export interface AccountsOverviewWire {
  accounts: PersonalAccountWire[];
  mailboxes: number;
  sites: Array<{ id: string; name: string; domain: string }>;
  oauth: {
    GITHUB: { ready: boolean; redirectUri: string; tokenUrl: string };
    REDDIT: { ready: boolean; redirectUri: string };
  };
}

export interface GitHubIdentityWire {
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  htmlUrl: string;
  publicRepos: number;
  followers: number;
}

export interface GitHubRepoWire {
  fullName: string;
  description: string | null;
  htmlUrl: string;
  stars: number;
  forks: number;
  openIssues: number;
  language: string | null;
  topics: string[];
  isPrivate: boolean;
  isFork: boolean;
  pushedAt: string | null;
  license: string | null;
  homepage: string | null;
}

export interface GitHubRepoDetailWire extends GitHubRepoWire {
  latestRelease: { tag: string; name: string | null; url: string; publishedAt: string | null } | null;
  readmeHtml: string | null;
  starred: boolean;
  watching: boolean;
}

export interface GitHubNotificationWire {
  id: string;
  reason: string;
  unread: boolean;
  updatedAt: string | null;
  title: string;
  type: string;
  repo: string;
  url: string | null;
}

export interface GitHubIssueWire {
  number: number;
  title: string;
  state: string;
  isPullRequest: boolean;
  author: string | null;
  comments: number;
  createdAt: string | null;
  updatedAt: string | null;
  labels: string[];
  url: string;
}

export interface GitHubCommentWire {
  id: number;
  author: string | null;
  bodyHtml: string;
  createdAt: string | null;
  url: string;
}

export interface RedditThingWire {
  name: string;
  kind: 'comment' | 'post' | 'message' | 'other';
  author: string | null;
  subreddit: string | null;
  title: string | null;
  body: string | null;
  url: string | null;
  score: number | null;
  comments: number | null;
  createdAt: string | null;
  unread: boolean;
  inboxType: 'comment_reply' | 'post_reply' | 'username_mention' | 'message' | null;
}

export interface RedditIdentityWire {
  name: string;
  handle: string;
  linkKarma: number;
  commentKarma: number;
  totalKarma: number;
  createdAt: string | null;
  hasMail: boolean;
  inboxCount: number;
}

export type RedditComposeResult =
  | { status: 'published'; url: string | null; warnings: string[] }
  | { status: 'queued'; websiteId: string; postId: string; copiedAccount: boolean }
  | { status: 'blocked'; blockers: string[]; warnings: string[] };
