import type { ImapSmtpConfig } from './types';

/**
 * Known mail providers, detected from the address so connecting a mailbox is "type your email,
 * paste a password". Big providers stopped accepting the account password over IMAP years ago,
 * so each preset says exactly where its app password is created.
 */

export interface MailPreset {
  id: 'gmail' | 'outlook' | 'icloud' | 'yahoo' | 'custom';
  label: string;
  domains: readonly string[];
  config: ImapSmtpConfig | null;
  /** Where the app password is created, when the provider requires one. */
  appPasswordUrl: string | null;
  steps: readonly string[];
}

export const MAIL_PRESETS: readonly MailPreset[] = [
  {
    id: 'gmail',
    label: 'Gmail',
    domains: ['gmail.com', 'googlemail.com'],
    config: {
      imap: { host: 'imap.gmail.com', port: 993, secure: true },
      smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
      smtpSavesSent: true,
    },
    appPasswordUrl: 'https://myaccount.google.com/apppasswords',
    steps: [
      'Turn on 2-Step Verification for the Google account (Google only offers app passwords with it on).',
      'Open the app passwords page, name it "SEO OS" and press Create.',
      'Paste the 16-character password below. Your normal Google password is never used or stored.',
    ],
  },
  {
    id: 'outlook',
    label: 'Outlook / Hotmail',
    domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'outlook.es', 'hotmail.es'],
    config: {
      imap: { host: 'outlook.office365.com', port: 993, secure: true },
      smtp: { host: 'smtp.office365.com', port: 587, secure: false },
      smtpSavesSent: true,
    },
    appPasswordUrl: 'https://account.live.com/proofs/AppPassword',
    steps: [
      'Turn on two-step verification for the Microsoft account.',
      'Create an app password on the Security page.',
      'Paste it below.',
    ],
  },
  {
    id: 'icloud',
    label: 'iCloud Mail',
    domains: ['icloud.com', 'me.com', 'mac.com'],
    config: {
      imap: { host: 'imap.mail.me.com', port: 993, secure: true },
      smtp: { host: 'smtp.mail.me.com', port: 587, secure: false },
    },
    appPasswordUrl: 'https://account.apple.com/account/manage',
    steps: [
      'Sign in to your Apple Account and open Sign-In and Security → App-Specific Passwords.',
      'Generate a password named "SEO OS".',
      'Paste it below.',
    ],
  },
  {
    id: 'yahoo',
    label: 'Yahoo Mail',
    domains: ['yahoo.com', 'yahoo.es', 'ymail.com'],
    config: {
      imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true },
      smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
    },
    appPasswordUrl: 'https://login.yahoo.com/account/security',
    steps: ['Open Account security and choose Generate app password.', 'Name it "SEO OS".', 'Paste it below.'],
  },
];

const CUSTOM: MailPreset = {
  id: 'custom',
  label: 'Other provider',
  domains: [],
  config: null,
  appPasswordUrl: null,
  steps: [
    'Find your provider\'s IMAP and SMTP server names and ports (usually on its help pages).',
    'Use an app password if your provider offers one.',
    'Fill in the servers and password below.',
  ],
};

/** The preset for an address, or the custom-server preset. Domain match is exact, case-insensitive. */
export function detectMailPreset(email: string): MailPreset {
  const domain = email.trim().toLowerCase().split('@')[1] ?? '';
  return MAIL_PRESETS.find((preset) => preset.domains.includes(domain)) ?? CUSTOM;
}
