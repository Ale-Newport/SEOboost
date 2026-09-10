import type { LucideIcon } from 'lucide-react';
import {
  Activity, BarChart3, Bot, Boxes, Braces, CalendarDays, CheckSquare, Compass, FileText,
  Gauge, Globe, History, KeyRound, LayoutDashboard, Library, Link2, ListChecks, Network,
  Search, Settings, Sparkles, Target, TrendingUp, Users, Wrench,
} from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  description?: string;
  /** Rendered as a count badge when the layout supplies a value for this key. */
  badgeKey?: 'pendingApprovals' | 'runningJobs' | 'openOpportunities';
}

export const GLOBAL_NAV: Array<{ section: string; items: NavItem[] }> = [
  {
    section: 'Overview',
    items: [
      { href: '/', label: 'Dashboard', icon: LayoutDashboard, description: 'Portfolio-wide command center' },
      { href: '/sites', label: 'Sites', icon: Globe, description: 'Every website you manage' },
    ],
  },
  {
    section: 'Work',
    items: [
      { href: '/opportunities', label: 'Opportunities', icon: Target, description: 'Ranked growth opportunities', badgeKey: 'openOpportunities' },
      { href: '/actions', label: 'AI Actions', icon: Sparkles, description: 'What the agents propose to do next' },
      { href: '/approvals', label: 'Approvals', icon: CheckSquare, description: 'Changes waiting for your decision', badgeKey: 'pendingApprovals' },
      { href: '/calendar', label: 'Content calendar', icon: CalendarDays, description: 'Pipeline across every site' },
    ],
  },
  {
    section: 'System',
    items: [
      { href: '/reports', label: 'Reports', icon: FileText, description: 'Weekly and monthly summaries' },
      { href: '/jobs', label: 'Jobs', icon: Activity, description: 'Background job queue and history', badgeKey: 'runningJobs' },
      { href: '/settings', label: 'Settings', icon: Settings, description: 'Providers, integrations and defaults' },
    ],
  },
];

export function siteNav(websiteId: string): Array<{ section: string; items: NavItem[] }> {
  const base = `/sites/${websiteId}`;
  return [
    {
      section: 'Performance',
      items: [
        { href: base, label: 'Overview', icon: Gauge },
        { href: `${base}/analytics`, label: 'Analytics', icon: BarChart3 },
        { href: `${base}/keywords`, label: 'Keywords', icon: KeyRound },
        { href: `${base}/pages`, label: 'Pages', icon: Library },
      ],
    },
    {
      section: 'Growth',
      items: [
        { href: `${base}/opportunities`, label: 'Opportunities', icon: Target },
        { href: `${base}/content`, label: 'Content', icon: FileText },
        { href: `${base}/competitors`, label: 'Competitors', icon: Users },
        { href: `${base}/strategy`, label: 'AI SEO Manager', icon: Bot },
      ],
    },
    {
      section: 'Foundations',
      items: [
        { href: `${base}/technical`, label: 'Technical SEO', icon: Wrench },
        { href: `${base}/links`, label: 'Internal links', icon: Link2 },
        { href: `${base}/architecture`, label: 'Architecture', icon: Network },
        { href: `${base}/schema`, label: 'Structured data', icon: Braces },
        { href: `${base}/indexation`, label: 'Indexation', icon: Search },
        { href: `${base}/backlinks`, label: 'Backlinks', icon: TrendingUp },
      ],
    },
    {
      section: 'AI search',
      items: [
        { href: `${base}/geo`, label: 'GEO readiness', icon: Compass },
        { href: `${base}/ai-visibility`, label: 'AI visibility', icon: Sparkles },
        { href: `${base}/entities`, label: 'Entity graph', icon: Boxes },
      ],
    },
    {
      section: 'Operations',
      items: [
        { href: `${base}/automations`, label: 'Automations', icon: ListChecks },
        { href: `${base}/history`, label: 'History', icon: History },
        { href: `${base}/settings`, label: 'Settings', icon: Settings },
      ],
    },
  ];
}
