import { createLogger, env, errorMessage } from '@seo/shared';
import { checkDatabaseConnection, disconnectPrisma, prisma } from './client';
import { clearDemoData, seedDemoData, type DemoSeedResult } from './seed/demo';
import { ensureOwnerAccount } from './seed/owner';
import { ensureAppSettings } from './seed/settings';
import type { SeedStepResult } from './seed/types';

/**
 * Database seed.
 *
 * Two modes, and the output always says which one ran:
 *
 *   base   — makes the installation usable: global AI routing defaults, and the owner account when
 *            SEED_EMAIL/SEED_PASSWORD are supplied. It creates no websites, no metrics and no
 *            issues. An empty product on a real database is the correct outcome here.
 *
 *   demo   — DEMO_MODE=true (or --demo) additionally builds three fictional websites marked
 *            `isDemo: true` and named "[DEMO] …", with pages, a crawl, real rule-engine issues,
 *            90 days of Search Console-shaped metrics, opportunities, a GEO audit, AI visibility
 *            records, actions, approvals and one evaluated experiment. Every row hangs off a demo
 *            website, so `--clear-demo` removes all of it.
 *
 * Requires only DATABASE_URL. No Redis, no API keys.
 */

const log = createLogger('seed');

const HELP = `
SEO OS — database seed

  npm run db:seed                     Base install: app settings (+ owner account if configured)
  DEMO_MODE=true npm run db:seed      Base install plus the clearly-labelled demo dataset
  npm run db:seed -- --demo           Same as DEMO_MODE=true, without editing .env
  npm run db:seed -- --clear-demo     Delete every website marked isDemo (cascades to everything)
  npm run db:seed -- --help           This message

Environment:
  SEED_EMAIL / SEED_PASSWORD   Optional. Both must be set to create the owner account
                               non-interactively; otherwise sign up through the UI.
  DEMO_MODE                    Optional. "true" enables the demo dataset.
`;

interface Args {
  help: boolean;
  clearDemo: boolean;
  demo: boolean;
}

function parseArgs(argv: string[]): Args {
  const flags = new Set(argv.filter((arg) => arg.startsWith('--')));
  return {
    help: flags.has('--help') || flags.has('-h'),
    clearDemo: flags.has('--clear-demo'),
    demo: flags.has('--demo'),
  };
}

const CLEAR_COMMAND = 'npm run db:seed -- --clear-demo';

function line(char = '─'): string {
  return char.repeat(74);
}

function printStep(label: string, result: SeedStepResult): void {
  if (result.status === 'ok') {
    console.log(`  ✓ ${label}: ${result.detail}`);
    return;
  }
  console.log(`  – ${label}: SKIPPED — ${result.reason}`);
  console.log(`      To enable: ${result.fix}`);
}

function printDemoSummary(demo: DemoSeedResult): void {
  const totals = new Map<string, number>();
  for (const site of demo.sites) {
    for (const [table, count] of Object.entries(site.counts)) {
      totals.set(table, (totals.get(table) ?? 0) + count);
    }
  }

  console.log('');
  console.log(line());
  console.log('  DEMO DATASET');
  console.log(line());
  for (const site of demo.sites) {
    console.log(
      `  ${site.name.padEnd(30)} ${site.domain.padEnd(30)} health ${String(site.healthScore).padStart(5)}  geo ${String(site.geoScore).padStart(5)}`,
    );
  }
  for (const skip of demo.skipped) {
    console.log(`  ! ${skip.domain}: not created — ${skip.reason}`);
  }

  console.log('');
  console.log('  Rows written:');
  const rows = [...totals.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  for (let i = 0; i < rows.length; i += 2) {
    const left = rows[i];
    const right = rows[i + 1];
    const format = (entry: [string, number] | undefined) =>
      entry ? `${entry[0].padEnd(26)}${String(entry[1]).padStart(7)}` : '';
    console.log(`    ${format(left)}   ${format(right)}`);
  }

  for (const experiment of demo.experiments) {
    console.log('');
    console.log(`  Experiment outcome (measured, not assigned): ${experiment}`);
  }

  console.log('');
  console.log('  Every demo website is marked isDemo=true and named with a "[DEMO] " prefix.');
  console.log(`  Remove all of it with:  ${CLEAR_COMMAND}`);
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  if (args.help) {
    console.log(HELP);
    return 0;
  }

  const connection = await checkDatabaseConnection();
  if (!connection.ok) {
    console.error('');
    console.error('  Cannot reach the database.');
    console.error(`  ${connection.error ?? 'unknown error'}`);
    console.error('  Check DATABASE_URL, then run: npm run db:migrate');
    console.error('');
    return 1;
  }

  if (args.clearDemo) {
    const cleared = await clearDemoData();
    console.log('');
    console.log(line());
    console.log('  MODE: CLEAR DEMO DATA');
    console.log(line());
    if (cleared.websites === 0) {
      console.log('  No demo websites found. Nothing to remove.');
    } else {
      for (const name of cleared.names) console.log(`  removed  ${name}`);
      console.log(`  ${cleared.websites} demo website(s) deleted, along with every row that hung off them.`);
    }
    console.log('');
    return 0;
  }

  // `--demo` exists so the dataset can be tried without editing .env; the banner always names the
  // trigger, because "why does my install have demo websites?" must never be a mystery.
  const demoTrigger = env.demoMode ? 'DEMO_MODE=true' : args.demo ? '--demo flag' : null;

  console.log('');
  console.log(line('═'));
  console.log(demoTrigger ? `  MODE: DEMO  (enabled by ${demoTrigger})` : '  MODE: BASE INSTALL  (no demo data)');
  console.log(line('═'));

  console.log('  Base install');
  const settings = await ensureAppSettings();
  printStep('app settings', settings);

  const owner = await ensureOwnerAccount();
  printStep('owner account', owner.result);

  if (!demoTrigger) {
    const existingDemo = await prisma.website.count({ where: { isDemo: true } });
    console.log('');
    console.log('  No websites, metrics or issues were created — that is what BASE INSTALL means.');
    console.log('  Add a real website through the UI, connect Search Console, and run a crawl.');
    if (existingDemo > 0) {
      console.log('');
      console.log(`  Note: ${existingDemo} demo website(s) from an earlier run are still present.`);
      console.log(`  Remove them with:  ${CLEAR_COMMAND}`);
    }
    console.log('');
    return 0;
  }

  if (!owner.userId) {
    console.log('');
    console.log('  – demo dataset: SKIPPED — demo websites must belong to a user, and this database has none.');
    console.log('      To enable: create an account (sign up in the UI, or set SEED_EMAIL and');
    console.log('      SEED_PASSWORD) and run the seed again.');
    console.log('');
    // Not a failure: the base install succeeded and the reason is explicit.
    return 0;
  }

  const now = new Date();
  const demo = await seedDemoData(owner.userId, now);
  printDemoSummary(demo);
  console.log('');
  return 0;
}

main(process.argv.slice(2))
  .then(async (code) => {
    await disconnectPrisma();
    process.exit(code);
  })
  .catch(async (error: unknown) => {
    log.error('seed failed', { error: errorMessage(error) });
    console.error('');
    console.error(`  Seed failed: ${errorMessage(error)}`);
    console.error('  Nothing was left half-written that a re-run will not replace.');
    console.error('');
    await disconnectPrisma().catch(() => undefined);
    process.exit(1);
  });
