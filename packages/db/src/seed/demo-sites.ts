import type { AutonomyLevel, CmsType, PageType } from '@prisma/client';

/**
 * Blueprints for the DEMO_MODE dataset.
 *
 * Everything here describes three *fictional* businesses on reserved `.example` domains, which can
 * never resolve — so nothing in this file can be mistaken for a real site, and a demo crawl can
 * never accidentally hit someone's server. The prose, metrics and defects are generated from these
 * declarations (see demo-pages.ts / demo-metrics.ts); the technical issues are then produced by
 * running the real `runTechnicalAudit` over the result rather than being written out by hand.
 *
 * Defects are declared explicitly (a missing title is `title: null`, not a flag) so that reading a
 * blueprint tells you exactly which findings that page is supposed to generate.
 */

export type DemoQuality = 'strong' | 'average' | 'weak';

export interface DemoPageBlueprint {
  path: string;
  pageType: PageType;
  /** Noun phrase. Drives the generated prose, the H1, anchors and the page's target keyword. */
  topic: string;
  /** H2 section headings. The body is generated section by section from these. */
  sections: string[];
  /** Omitted → generated from the topic. `null` → the page genuinely has no title tag. */
  title?: string | null;
  metaDescription?: string | null;
  /** Omitted → a single H1 from the topic. `[]` → no H1. Two entries → multiple H1s. */
  h1?: string[];
  schemaTypes?: string[];
  /** Defaults to 200. */
  statusCode?: number;
  /** Hops recorded before the URL resolved; ≥2 is what the redirect-chain rule looks for. */
  redirectChain?: string[];
  redirectTarget?: string | null;
  /** Omitted → self-referencing canonical. `null` → no canonical tag. A path → canonical elsewhere. */
  canonicalPath?: string | null;
  robotsMeta?: string | null;
  xRobotsTag?: string | null;
  noViewport?: boolean;
  noLang?: boolean;
  responseTimeMs?: number;
  contentBytes?: number;
  images?: number;
  imagesMissingAlt?: number;
  /** Sub-resources served over http:// on an https:// page. */
  insecureImages?: number;
  externalLinks?: number;
  /** Target body length in words. Omitted → derived from `quality`. */
  words?: number;
  quality?: DemoQuality;
  /** Paths linked from this page's body. Nav and footer links are added automatically. */
  linksTo?: string[];
  /** Reuse another page's body verbatim — produces a genuine DUPLICATE_CONTENT finding. */
  duplicateOf?: string;
  /** Reuse another page's body with a couple of sentences swapped — genuine NEAR_DUPLICATE. */
  nearDuplicateOf?: string;
  /** Omitted → in the sitemap when the site has one and the page returns 200. */
  inSitemap?: boolean;
  /** Emit an H4 directly after an H2 so the hierarchy rule has something real to find. */
  headingSkip?: boolean;
  /** This page renders without the site chrome, so it emits no nav or footer links. */
  noChrome?: boolean;
  targetKeywords?: string[];
  publishedDaysAgo?: number;
  updatedDaysAgo?: number;
}

export interface DemoQueryBlueprint {
  query: string;
  /** The page that ranks for it. Must match a blueprint path. */
  path: string;
  /** Daily impressions at the start of the 90-day window. */
  impressions: number;
  /** Average position at the start of the window. */
  position: number;
  /** Average position at the end of the window. Omitted → flat. */
  endPosition?: number;
  /** Impressions multiplier at the end of the window. 1 = flat, <1 = decaying demand. */
  demandTrend?: number;
  /**
   * Multiplier on the modelled position/CTR curve. 1 = exactly as expected for that position;
   * below ~0.55 is what the CTR-opportunity detector flags.
   */
  ctrFactor?: number;
  searchVolume?: number | null;
  branded?: boolean;
  /** A measured change: from this many days ago onwards, CTR is multiplied by `stepCtrFactor`. */
  stepDaysAgo?: number;
  stepCtrFactor?: number;
}

export interface DemoAiPromptBlueprint {
  prompt: string;
  category: string;
  /** Share of runs in which the brand is mentioned. Drives the generated run rows. */
  mentionRate: number;
  /** Fictional rivals, so no real company is described as being recommended over another. */
  competitors: string[];
}

export interface DemoSiteBlueprint {
  key: string;
  /** Stored with a "[DEMO] " prefix; kept unprefixed here so the prose reads naturally. */
  name: string;
  domain: string;
  brandName: string;
  description: string;
  businessCategory: string;
  targetAudience: string;
  /** Plural noun for the site's reader, used verbatim in generated prose. */
  readerNoun: string;
  conversionGoal: string;
  cmsType: CmsType;
  autonomyLevel: AutonomyLevel;
  /** Per-weekday traffic multiplier, index 0 = Sunday. This is the weekly seasonality. */
  weeklyShape: [number, number, number, number, number, number, number];
  robots: { found: boolean; disallow: string[] };
  sitemap: { found: boolean; errors: string[] };
  /** Linked from every page that renders the site chrome. */
  nav: string[];
  footer: string[];
  pages: DemoPageBlueprint[];
  queries: DemoQueryBlueprint[];
  aiPrompts: DemoAiPromptBlueprint[];
  /** Verified first-party facts the GEO scorer counts as evidence the site can cite. */
  facts: Array<{ fact: string; category: string }>;
  knowledge: {
    toneOfVoice: string;
    brandStyle: string;
    preferredCta: string;
    uniqueValueProps: string[];
    prohibitedClaims: string[];
    writingGuidelines: string;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. B2B SaaS — the healthiest of the three
// ─────────────────────────────────────────────────────────────────────────────

const NORTHWIND: DemoSiteBlueprint = {
  key: 'northwind',
  name: 'Northwind Signal',
  domain: 'northwind-signal.example',
  brandName: 'Northwind Signal',
  description: 'Inventory forecasting and replenishment software for mid-market retail and wholesale operators.',
  businessCategory: 'B2B SaaS — supply chain',
  targetAudience: 'Supply chain and merchandising leads at retailers doing $20M-$500M in annual revenue.',
  readerNoun: 'planning teams',
  conversionGoal: 'Book a product demo',
  cmsType: 'NEXTJS',
  autonomyLevel: 'L2_SAFE_TECHNICAL',
  // B2B: weekdays carry the traffic, weekends fall to roughly half.
  weeklyShape: [0.52, 1.16, 1.21, 1.18, 1.12, 0.95, 0.5],
  robots: { found: true, disallow: ['/api/', '/admin/'] },
  sitemap: { found: true, errors: [] },
  nav: ['/', '/product', '/pricing', '/integrations', '/customers', '/blog', '/about', '/contact'],
  footer: ['/legal/privacy', '/legal/terms'],
  pages: [
    {
      path: '/',
      pageType: 'HOMEPAGE',
      topic: 'inventory forecasting software',
      sections: ['What Northwind Signal does', 'Who it is built for', 'How the forecast is produced', 'Getting started'],
      title: 'Northwind Signal — Inventory Forecasting Software',
      schemaTypes: ['Organization', 'WebSite', 'WebPage'],
      quality: 'strong',
      words: 820,
      images: 6,
      linksTo: ['/product/demand-forecasting', '/pricing', '/customers', '/blog/inventory-forecasting-methods'],
      targetKeywords: ['inventory forecasting software', 'inventory planning tools'],
    },
    {
      path: '/product',
      pageType: 'LANDING',
      topic: 'the Northwind Signal platform',
      sections: ['Forecasting engine', 'Replenishment planning', 'Supplier performance', 'Security and data handling'],
      schemaTypes: ['SoftwareApplication', 'BreadcrumbList', 'WebPage'],
      quality: 'strong',
      words: 760,
      images: 5,
      linksTo: [
        '/product/demand-forecasting',
        '/product/replenishment',
        '/product/supplier-scorecards',
        '/integrations',
        '/compare/northwind-vs-spreadsheets',
      ],
      targetKeywords: ['inventory planning tools', 'inventory planning platform'],
    },
    {
      path: '/product/demand-forecasting',
      pageType: 'LANDING',
      topic: 'demand forecasting',
      sections: ['How the model works', 'Handling seasonality and promotions', 'Forecast accuracy reporting', 'What you need to start'],
      schemaTypes: ['SoftwareApplication', 'BreadcrumbList'],
      quality: 'strong',
      words: 940,
      images: 4,
      linksTo: ['/blog/inventory-forecasting-methods', '/glossary/safety-stock', '/pricing', '/blog/demand-planning-kpis'],
      targetKeywords: ['demand forecasting software', 'inventory forecasting software'],
    },
    {
      path: '/product/replenishment',
      pageType: 'LANDING',
      topic: 'automated replenishment',
      sections: ['Order suggestions', 'Lead time and supplier constraints', 'Approval workflow'],
      schemaTypes: ['SoftwareApplication', 'BreadcrumbList'],
      quality: 'average',
      words: 620,
      images: 3,
      linksTo: ['/glossary/reorder-point', '/product/supplier-scorecards'],
      targetKeywords: ['automated replenishment software'],
    },
    {
      path: '/product/supplier-scorecards',
      pageType: 'LANDING',
      topic: 'supplier scorecards',
      sections: ['What is measured', 'How scores are calculated', 'Using scores in planning'],
      // Deliberate: no meta description on a commercial page.
      metaDescription: null,
      schemaTypes: ['BreadcrumbList'],
      quality: 'average',
      words: 540,
      images: 2,
      imagesMissingAlt: 2,
      linksTo: ['/customers'],
      targetKeywords: ['supplier scorecard template', 'supplier performance scorecard'],
    },
    {
      path: '/pricing',
      pageType: 'LANDING',
      topic: 'Northwind Signal pricing',
      sections: ['Plans', 'What counts as a location', 'Implementation and onboarding', 'Frequently asked questions'],
      // Deliberate: 78 characters, well past the truncation point.
      title: 'Pricing and Plans for Northwind Signal Inventory Forecasting Software 2025',
      schemaTypes: ['FAQPage', 'BreadcrumbList'],
      quality: 'average',
      words: 610,
      images: 2,
      linksTo: ['/contact', '/compare/northwind-vs-spreadsheets'],
      targetKeywords: ['northwind signal pricing', 'inventory forecasting software pricing'],
    },
    {
      path: '/integrations',
      pageType: 'CATEGORY',
      topic: 'inventory system integrations',
      sections: ['Supported systems', 'How syncing works', 'Building a custom connection'],
      schemaTypes: ['BreadcrumbList'],
      quality: 'average',
      words: 470,
      linksTo: ['/integrations/shopify', '/integrations/netsuite'],
      targetKeywords: ['inventory system integrations'],
    },
    {
      path: '/integrations/shopify',
      pageType: 'LANDING',
      topic: 'Shopify inventory sync',
      sections: ['What syncs', 'Setup'],
      quality: 'weak',
      words: 340,
      schemaTypes: ['BreadcrumbList'],
      linksTo: ['/product/replenishment'],
      targetKeywords: ['shopify inventory forecasting'],
    },
    {
      path: '/integrations/netsuite',
      pageType: 'LANDING',
      topic: 'NetSuite inventory sync',
      sections: ['What syncs', 'Setup'],
      // Deliberate: the same stub with the vendor name swapped — a real near-duplicate.
      nearDuplicateOf: '/integrations/shopify',
      quality: 'weak',
      words: 340,
      schemaTypes: ['BreadcrumbList'],
      linksTo: ['/product/replenishment'],
      targetKeywords: ['netsuite inventory planning'],
    },
    {
      path: '/customers',
      pageType: 'CATEGORY',
      topic: 'customer results',
      sections: ['Who uses Northwind Signal', 'Measured outcomes', 'How rollouts usually run'],
      schemaTypes: ['BreadcrumbList'],
      quality: 'strong',
      words: 700,
      images: 5,
      imagesMissingAlt: 3,
      linksTo: ['/product/supplier-scorecards', '/compare/northwind-vs-spreadsheets'],
      targetKeywords: ['inventory forecasting case studies'],
    },
    {
      path: '/about',
      pageType: 'ABOUT',
      topic: 'the team behind Northwind Signal',
      sections: ['Why we built this', 'How we work', 'Where we are'],
      schemaTypes: ['AboutPage', 'Organization'],
      quality: 'strong',
      words: 560,
      linksTo: ['/contact', '/customers'],
      targetKeywords: ['about northwind signal'],
    },
    {
      path: '/contact',
      pageType: 'CONTACT',
      topic: 'contacting the Northwind Signal team',
      sections: ['Talk to sales', 'Support', 'Response times'],
      // Deliberate: a contact page with almost no copy — extremely common, and a real finding.
      quality: 'weak',
      words: 195,
      schemaTypes: ['ContactPage'],
      targetKeywords: ['contact northwind signal'],
    },
    {
      path: '/blog',
      pageType: 'BLOG_INDEX',
      topic: 'the Northwind Signal inventory blog',
      sections: ['Latest posts', 'Popular guides'],
      schemaTypes: ['CollectionPage', 'BreadcrumbList'],
      quality: 'average',
      words: 340,
      linksTo: [
        '/blog/inventory-forecasting-methods',
        '/blog/safety-stock-formula',
        '/blog/demand-planning-kpis',
        '/blog/abc-analysis-inventory',
        '/blog/stockout-cost-calculation',
        // One link left pointing at a redirect after a URL change.
        '/product/demand-forecasting-old',
      ],
      targetKeywords: ['inventory management blog'],
    },
    {
      path: '/blog/inventory-forecasting-methods',
      pageType: 'ARTICLE',
      topic: 'inventory forecasting methods',
      sections: [
        'Moving averages and exponential smoothing',
        'Seasonal decomposition',
        'Machine-learning forecasts',
        'Choosing a method for your catalogue',
        'Measuring forecast accuracy',
      ],
      schemaTypes: ['Article', 'BreadcrumbList'],
      quality: 'strong',
      words: 1450,
      images: 4,
      externalLinks: 3,
      publishedDaysAgo: 240,
      updatedDaysAgo: 61,
      linksTo: ['/blog/safety-stock-formula', '/glossary/safety-stock', '/product/demand-forecasting'],
      targetKeywords: ['inventory forecasting methods', 'forecasting methods for inventory'],
    },
    {
      path: '/blog/safety-stock-formula',
      pageType: 'ARTICLE',
      topic: 'the safety stock formula',
      sections: [
        'What safety stock protects against',
        'The standard formula',
        'Choosing a service level',
        'Worked example',
        'Common mistakes',
      ],
      schemaTypes: ['Article', 'BreadcrumbList'],
      quality: 'strong',
      words: 1180,
      images: 3,
      externalLinks: 2,
      publishedDaysAgo: 420,
      updatedDaysAgo: 130,
      linksTo: ['/glossary/safety-stock', '/glossary/reorder-point', '/product/demand-forecasting'],
      targetKeywords: ['safety stock formula', 'how to calculate safety stock'],
    },
    {
      path: '/blog/demand-planning-kpis',
      pageType: 'ARTICLE',
      topic: 'demand planning KPIs',
      sections: ['Forecast accuracy', 'Bias', 'Service level', 'Inventory turns'],
      schemaTypes: ['Article', 'BreadcrumbList'],
      quality: 'average',
      words: 820,
      images: 2,
      headingSkip: true,
      publishedDaysAgo: 180,
      linksTo: ['/blog/abc-analysis-inventory', '/product/demand-forecasting'],
      targetKeywords: ['demand planning kpis'],
    },
    {
      path: '/blog/abc-analysis-inventory',
      pageType: 'ARTICLE',
      topic: 'ABC analysis for inventory',
      sections: ['How ABC classification works', 'Setting the thresholds', 'Combining ABC with XYZ analysis'],
      schemaTypes: ['Article', 'BreadcrumbList'],
      quality: 'average',
      words: 880,
      images: 2,
      publishedDaysAgo: 150,
      linksTo: ['/blog/demand-planning-kpis'],
      targetKeywords: ['abc analysis inventory'],
    },
    {
      path: '/blog/stockout-cost-calculation',
      pageType: 'ARTICLE',
      topic: 'calculating the cost of a stockout',
      sections: ['Direct lost margin'],
      // Deliberate: an abandoned draft that was published anyway.
      quality: 'weak',
      words: 205,
      schemaTypes: ['Article'],
      publishedDaysAgo: 95,
      linksTo: ['/blog/safety-stock-formula'],
      targetKeywords: ['stockout cost'],
    },
    {
      path: '/blog/inventory-turnover-ratio',
      pageType: 'ARTICLE',
      topic: 'the inventory turnover ratio',
      sections: ['The formula', 'What a healthy turn rate looks like', 'Improving turns without raising stockouts'],
      schemaTypes: ['Article', 'BreadcrumbList'],
      quality: 'average',
      words: 760,
      images: 2,
      publishedDaysAgo: 70,
      // Deliberate orphan: nothing links here, it is only in the sitemap.
      linksTo: ['/blog/abc-analysis-inventory'],
      targetKeywords: ['inventory turnover ratio'],
    },
    {
      path: '/glossary/safety-stock',
      pageType: 'GLOSSARY',
      topic: 'safety stock',
      sections: ['Definition', 'Related terms'],
      // Deliberate: no canonical tag on a page that has parameter variants in the wild.
      canonicalPath: null,
      quality: 'weak',
      words: 340,
      schemaTypes: ['BreadcrumbList'],
      linksTo: ['/blog/safety-stock-formula'],
      targetKeywords: ['safety stock definition'],
    },
    {
      path: '/glossary/reorder-point',
      pageType: 'GLOSSARY',
      topic: 'reorder point',
      sections: ['Definition', 'Related terms'],
      nearDuplicateOf: '/glossary/safety-stock',
      quality: 'weak',
      words: 340,
      schemaTypes: ['BreadcrumbList'],
      linksTo: ['/product/replenishment'],
      targetKeywords: ['reorder point formula'],
    },
    {
      path: '/compare/northwind-vs-spreadsheets',
      pageType: 'COMPARISON',
      topic: 'inventory forecasting in spreadsheets versus dedicated software',
      sections: ['Where spreadsheets hold up', 'Where they break', 'Migration path', 'Cost comparison'],
      title: 'Inventory Forecasting: Spreadsheets vs Software',
      schemaTypes: ['Article', 'BreadcrumbList'],
      quality: 'strong',
      words: 1020,
      images: 2,
      externalLinks: 1,
      publishedDaysAgo: 200,
      linksTo: ['/pricing', '/product/demand-forecasting'],
      targetKeywords: ['inventory forecasting spreadsheet'],
    },
    {
      path: '/legal/privacy',
      pageType: 'LEGAL',
      topic: 'the Northwind Signal privacy policy',
      sections: ['What we collect', 'How long we keep it', 'Your rights'],
      robotsMeta: 'noindex, follow',
      quality: 'average',
      words: 620,
      linksTo: ['/legal/terms'],
    },
    {
      path: '/legal/terms',
      pageType: 'LEGAL',
      topic: 'the Northwind Signal terms of service',
      sections: ['Using the service', 'Payment', 'Termination'],
      robotsMeta: 'noindex, follow',
      quality: 'average',
      words: 640,
      linksTo: ['/legal/privacy'],
    },
    {
      path: '/product/demand-forecasting-old',
      pageType: 'LANDING',
      topic: 'the retired forecasting product page',
      sections: [],
      statusCode: 301,
      redirectTarget: '/product/demand-forecasting',
      redirectChain: ['/product/demand-forecasting-old', '/product/demand-forecasting'],
      inSitemap: false,
    },
  ],
  queries: [
    { query: 'inventory forecasting software', path: '/product/demand-forecasting', impressions: 420, position: 11.4, endPosition: 9.2, searchVolume: 2400 },
    { query: 'demand forecasting software', path: '/product/demand-forecasting', impressions: 310, position: 14.1, endPosition: 12.8, searchVolume: 1900 },
    // Ranks well but is badly under-clicked — the CTR-opportunity detector should find this.
    { query: 'safety stock formula', path: '/blog/safety-stock-formula', impressions: 890, position: 4.2, endPosition: 3.6, ctrFactor: 0.34, searchVolume: 6600 },
    { query: 'how to calculate safety stock', path: '/blog/safety-stock-formula', impressions: 540, position: 6.8, searchVolume: 3600 },
    // The experiment page: a meta-description rewrite 63 days ago.
    { query: 'inventory forecasting methods', path: '/blog/inventory-forecasting-methods', impressions: 380, position: 5.1, searchVolume: 1300, stepDaysAgo: 63, stepCtrFactor: 1.34 },
    { query: 'forecasting methods for inventory', path: '/blog/inventory-forecasting-methods', impressions: 210, position: 7.8, searchVolume: 480, stepDaysAgo: 63, stepCtrFactor: 1.29 },
    { query: 'reorder point formula', path: '/glossary/reorder-point', impressions: 610, position: 12.6, endPosition: 11.9, searchVolume: 4400 },
    { query: 'abc analysis inventory', path: '/blog/abc-analysis-inventory', impressions: 290, position: 9.4, searchVolume: 2900 },
    { query: 'demand planning kpis', path: '/blog/demand-planning-kpis', impressions: 160, position: 16.2, searchVolume: 720 },
    { query: 'inventory turnover ratio', path: '/blog/inventory-turnover-ratio', impressions: 740, position: 18.5, endPosition: 17.2, searchVolume: 8100 },
    { query: 'northwind signal', path: '/', impressions: 210, position: 1.2, branded: true, searchVolume: 260 },
    { query: 'northwind signal pricing', path: '/pricing', impressions: 95, position: 1.6, branded: true, searchVolume: 110 },
    { query: 'shopify inventory forecasting', path: '/integrations/shopify', impressions: 230, position: 21.4, endPosition: 19.6, searchVolume: 880 },
    { query: 'netsuite inventory planning', path: '/integrations/netsuite', impressions: 140, position: 24.8, searchVolume: 390 },
    { query: 'stockout cost', path: '/blog/stockout-cost-calculation', impressions: 120, position: 27.5, demandTrend: 0.7, searchVolume: 590 },
    { query: 'supplier scorecard template', path: '/product/supplier-scorecards', impressions: 350, position: 13.8, searchVolume: 1600 },
    { query: 'inventory forecasting spreadsheet', path: '/compare/northwind-vs-spreadsheets', impressions: 270, position: 10.7, searchVolume: 1100 },
    { query: 'automated replenishment software', path: '/product/replenishment', impressions: 180, position: 15.3, searchVolume: 590 },
    { query: 'inventory planning tools', path: '/product', impressions: 300, position: 19.8, endPosition: 16.4, searchVolume: 3300 },
  ],
  aiPrompts: [
    {
      prompt: 'What software helps mid-market retailers forecast inventory demand?',
      category: 'category discovery',
      mentionRate: 0.62,
      competitors: ['Harborline Supply', 'StockPilot', 'Verity Planning'],
    },
    {
      prompt: 'How do I calculate safety stock for seasonal products?',
      category: 'informational',
      mentionRate: 0.34,
      competitors: ['Harborline Supply'],
    },
    {
      prompt: 'Is Northwind Signal a good fit for a wholesaler with 12 warehouses?',
      category: 'branded',
      mentionRate: 0.94,
      competitors: ['StockPilot'],
    },
    {
      prompt: 'Best alternatives to spreadsheet-based inventory planning',
      category: 'comparison',
      mentionRate: 0.41,
      competitors: ['Harborline Supply', 'StockPilot', 'Verity Planning', 'Cadence Ops'],
    },
    {
      prompt: 'Which inventory forecasting tools integrate with Shopify and NetSuite?',
      category: 'integration',
      mentionRate: 0.27,
      competitors: ['StockPilot', 'Cadence Ops'],
    },
  ],
  facts: [
    { fact: 'Northwind Signal serves 140 mid-market retail and wholesale customers across 9 countries.', category: 'company' },
    { fact: 'Customer forecasts are recalculated nightly at SKU-location level, with a 13-month history requirement.', category: 'product' },
    { fact: 'The platform reports forecast accuracy as weighted MAPE against actual shipments, not against plan.', category: 'methodology' },
    { fact: 'Implementation takes 4 to 6 weeks for a single-ERP customer and includes historical data validation.', category: 'onboarding' },
  ],
  knowledge: {
    toneOfVoice: 'Direct, specific, practitioner to practitioner. No hype, no superlatives.',
    brandStyle: 'Plain sentences. Numbers with their units. Every claim traceable to a measurement.',
    preferredCta: 'Book a 30-minute demo with a planner, not a salesperson.',
    uniqueValueProps: [
      'Forecasts at SKU-location level rather than at category level',
      'Explains every order suggestion with the lead time and demand signal behind it',
      'Runs against the ERP you already have',
    ],
    prohibitedClaims: [
      'Never state a guaranteed percentage reduction in stockouts',
      'Never describe the forecast as "AI-powered" without naming the actual method',
    ],
    writingGuidelines:
      'Lead with the practitioner problem. Show the formula before the product. Use British or American spelling consistently per locale, never mixed.',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. DTC ecommerce — the classic Shopify problem set
// ─────────────────────────────────────────────────────────────────────────────

const CEDAR_SAGE: DemoSiteBlueprint = {
  key: 'cedar-sage',
  name: 'Cedar & Sage Home',
  domain: 'cedarandsagehome.example',
  brandName: 'Cedar & Sage',
  description: 'Organic linen and cotton bedding, bath and kitchen textiles sold direct to consumers.',
  businessCategory: 'DTC ecommerce — home textiles',
  targetAudience: 'Homeowners aged 30-55 furnishing a bedroom or bathroom who care about material sourcing.',
  readerNoun: 'households',
  conversionGoal: 'Complete a first purchase',
  cmsType: 'SHOPIFY',
  autonomyLevel: 'L1_DRAFTS_ONLY',
  // Consumer retail: the weekend is the peak, Monday is the trough.
  weeklyShape: [1.18, 0.82, 0.86, 0.9, 0.96, 1.08, 1.2],
  robots: { found: true, disallow: ['/cart', '/checkout', '/account'] },
  sitemap: { found: true, errors: [] },
  nav: ['/', '/collections/bedding', '/collections/bath', '/collections/kitchen', '/blogs/journal', '/pages/about', '/pages/contact'],
  footer: ['/policies/privacy-policy', '/policies/refund-policy'],
  pages: [
    {
      path: '/',
      pageType: 'HOMEPAGE',
      topic: 'organic linen bedding',
      sections: ['Made from certified organic fibre', 'What we sell', 'How we ship'],
      title: 'Cedar & Sage — Organic Linen Bedding, Bath and Kitchen Textiles',
      schemaTypes: ['Organization', 'WebSite', 'WebPage'],
      quality: 'strong',
      words: 640,
      images: 8,
      imagesMissingAlt: 2,
      linksTo: ['/collections/bedding', '/products/linen-duvet-cover', '/pages/materials', '/collections/sale'],
      targetKeywords: ['organic linen bedding'],
    },
    {
      path: '/collections/bedding',
      pageType: 'CATEGORY',
      topic: 'the organic bedding collection',
      sections: ['Shop bedding'],
      // Deliberate: a stock Shopify collection page with almost no copy, and a slow response.
      quality: 'weak',
      words: 135,
      responseTimeMs: 2400,
      schemaTypes: ['CollectionPage'],
      images: 12,
      imagesMissingAlt: 5,
      linksTo: [
        '/products/linen-duvet-cover',
        '/products/stonewashed-sheet-set',
        '/products/organic-cotton-pillowcases',
        // The facet links are how the crawlable URL space gets discovered in the first place.
        '/collections/bedding?color=sand&size=queen&sort=price-ascending',
      ],
      targetKeywords: ['organic bedding'],
    },
    {
      path: '/collections/bath',
      pageType: 'CATEGORY',
      topic: 'the organic bath collection',
      sections: ['Shop bath'],
      quality: 'weak',
      words: 140,
      schemaTypes: ['CollectionPage'],
      images: 9,
      imagesMissingAlt: 4,
      linksTo: ['/products/waffle-bath-towel', '/products/discontinued-waffle-robe'],
      targetKeywords: ['organic bath towels'],
    },
    {
      path: '/collections/kitchen',
      pageType: 'CATEGORY',
      topic: 'the kitchen textiles collection',
      sections: ['Shop kitchen'],
      quality: 'weak',
      words: 128,
      schemaTypes: ['CollectionPage'],
      images: 7,
      imagesMissingAlt: 3,
      linksTo: ['/products/linen-table-runner', '/products/ceramic-mug-set'],
      targetKeywords: ['linen kitchen textiles'],
    },
    {
      path: '/collections/bedding?color=sand&size=queen&sort=price-ascending',
      pageType: 'CATEGORY',
      topic: 'filtered bedding results',
      sections: ['Shop bedding'],
      // Deliberate: faceted navigation generating crawlable URL space.
      duplicateOf: '/collections/bedding',
      canonicalPath: '/collections/bedding',
      quality: 'weak',
      words: 135,
      schemaTypes: ['CollectionPage'],
      inSitemap: false,
    },
    {
      path: '/products/linen-duvet-cover',
      pageType: 'PRODUCT',
      topic: 'the washed linen duvet cover',
      sections: ['Fabric and weave', 'Sizing', 'Care', 'Shipping and returns'],
      title: 'Washed Linen Duvet Cover | Cedar & Sage',
      schemaTypes: ['Product', 'BreadcrumbList'],
      quality: 'average',
      words: 480,
      images: 6,
      imagesMissingAlt: 2,
      linksTo: ['/pages/care-guide', '/pages/materials'],
      targetKeywords: ['linen duvet cover'],
    },
    {
      path: '/products/linen-duvet-cover-sand',
      pageType: 'PRODUCT',
      topic: 'the washed linen duvet cover in sand',
      sections: ['Fabric and weave', 'Sizing', 'Care', 'Shipping and returns'],
      // Deliberate: colour variants published as separate URLs with identical copy and titles.
      title: 'Washed Linen Duvet Cover | Cedar & Sage',
      duplicateOf: '/products/linen-duvet-cover',
      h1: ['The washed linen duvet cover'],
      schemaTypes: ['Product'],
      quality: 'average',
      words: 480,
      images: 6,
      imagesMissingAlt: 2,
      linksTo: ['/products/linen-duvet-cover'],
      targetKeywords: ['linen duvet cover sand'],
    },
    {
      path: '/products/linen-duvet-cover-clay',
      pageType: 'PRODUCT',
      topic: 'the washed linen duvet cover in clay',
      sections: ['Fabric and weave', 'Sizing', 'Care', 'Shipping and returns'],
      title: 'Washed Linen Duvet Cover | Cedar & Sage',
      duplicateOf: '/products/linen-duvet-cover',
      h1: ['The washed linen duvet cover'],
      schemaTypes: ['Product'],
      quality: 'average',
      words: 480,
      images: 6,
      imagesMissingAlt: 2,
      linksTo: ['/products/linen-duvet-cover'],
      targetKeywords: ['linen duvet cover clay'],
    },
    {
      path: '/products/waffle-bath-towel',
      pageType: 'PRODUCT',
      topic: 'the waffle-weave bath towel',
      sections: ['Fabric and weave', 'Absorbency', 'Care'],
      schemaTypes: ['Product', 'BreadcrumbList'],
      quality: 'average',
      words: 430,
      images: 5,
      // Deliberate: legacy CDN assets still served over plain http.
      insecureImages: 2,
      linksTo: ['/pages/care-guide'],
      targetKeywords: ['waffle bath towel'],
    },
    {
      path: '/products/stonewashed-sheet-set',
      pageType: 'PRODUCT',
      topic: 'the stonewashed sheet set',
      sections: ['What is included', 'Fabric and weave', 'Sizing'],
      metaDescription: null,
      schemaTypes: ['Product', 'BreadcrumbList'],
      quality: 'average',
      words: 455,
      images: 5,
      imagesMissingAlt: 1,
      linksTo: ['/blogs/journal/bedding-size-guide'],
      targetKeywords: ['stonewashed sheet set'],
    },
    {
      path: '/products/organic-cotton-pillowcases',
      pageType: 'PRODUCT',
      topic: 'organic cotton pillowcases',
      sections: ['Fabric and weave', 'Sizing', 'Care'],
      // Deliberate: the theme dropped the title tag on this template.
      title: null,
      schemaTypes: ['Product'],
      quality: 'average',
      words: 410,
      images: 4,
      linksTo: ['/pages/materials'],
      targetKeywords: ['organic cotton pillowcases'],
    },
    {
      path: '/products/linen-table-runner',
      pageType: 'PRODUCT',
      topic: 'the linen table runner',
      sections: ['Fabric and weave', 'Sizing', 'Care'],
      schemaTypes: ['Product'],
      quality: 'average',
      words: 390,
      images: 4,
      imagesMissingAlt: 4,
      targetKeywords: ['linen table runner'],
    },
    {
      path: '/products/ceramic-mug-set',
      pageType: 'PRODUCT',
      topic: 'the stoneware mug set',
      sections: ['Materials', 'Dimensions', 'Care'],
      schemaTypes: ['Product'],
      quality: 'average',
      words: 375,
      images: 4,
      targetKeywords: ['stoneware mug set'],
    },
    {
      path: '/collections/sale',
      pageType: 'CATEGORY',
      topic: 'the sale collection',
      sections: [],
      // Deliberate: the sale template is throwing on an empty collection.
      statusCode: 500,
      inSitemap: false,
    },
    {
      path: '/products/discontinued-waffle-robe',
      pageType: 'PRODUCT',
      topic: 'the discontinued waffle robe',
      sections: [],
      statusCode: 410,
      inSitemap: false,
    },
    {
      path: '/pages/about',
      pageType: 'ABOUT',
      topic: 'the story behind Cedar & Sage',
      sections: ['How we started', 'Where our fabric comes from', 'What we will not do'],
      schemaTypes: ['AboutPage'],
      quality: 'strong',
      words: 620,
      images: 3,
      linksTo: ['/pages/materials', '/pages/contact'],
      targetKeywords: ['about cedar and sage'],
    },
    {
      path: '/pages/contact',
      pageType: 'CONTACT',
      topic: 'contacting Cedar & Sage',
      sections: ['Customer care', 'Wholesale'],
      schemaTypes: ['ContactPage'],
      quality: 'weak',
      words: 210,
      targetKeywords: ['cedar and sage contact'],
    },
    {
      path: '/pages/materials',
      pageType: 'OTHER',
      topic: 'the fibres and certifications we use',
      sections: ['European flax linen', 'GOTS organic cotton', 'Dyes and finishing', 'What certification does not cover'],
      schemaTypes: ['WebPage'],
      quality: 'strong',
      words: 1080,
      images: 3,
      externalLinks: 3,
      linksTo: ['/blogs/journal/gots-certification-explained', '/products/linen-duvet-cover'],
      targetKeywords: ['gots certified bedding', 'european flax linen'],
    },
    {
      path: '/pages/care-guide',
      pageType: 'OTHER',
      topic: 'caring for linen and cotton textiles',
      sections: ['Washing', 'Drying', 'Storage', 'Stain removal'],
      schemaTypes: ['WebPage', 'HowTo'],
      quality: 'strong',
      words: 890,
      images: 2,
      linksTo: ['/blogs/journal/how-to-wash-linen-sheets'],
      targetKeywords: ['linen care guide'],
    },
    {
      path: '/blogs/journal',
      pageType: 'BLOG_INDEX',
      topic: 'the Cedar & Sage journal',
      sections: ['Recent posts'],
      schemaTypes: ['CollectionPage'],
      quality: 'weak',
      words: 190,
      linksTo: [
        '/blogs/journal/how-to-wash-linen-sheets',
        '/blogs/journal/linen-vs-cotton-sheets',
        '/blogs/journal/gots-certification-explained',
        '/blogs/journal/bedding-size-guide',
        '/blogs/journal/summer-bedding-edit',
      ],
      targetKeywords: ['cedar and sage journal'],
    },
    {
      path: '/blogs/journal/how-to-wash-linen-sheets',
      pageType: 'ARTICLE',
      topic: 'washing linen sheets',
      sections: ['Water temperature', 'Detergent choice', 'Drying without damage', 'Softening over time'],
      schemaTypes: ['Article', 'BreadcrumbList'],
      quality: 'strong',
      words: 1120,
      images: 3,
      publishedDaysAgo: 300,
      updatedDaysAgo: 40,
      linksTo: ['/pages/care-guide', '/products/stonewashed-sheet-set'],
      targetKeywords: ['how to wash linen sheets'],
    },
    {
      path: '/blogs/journal/linen-vs-cotton-sheets',
      pageType: 'COMPARISON',
      topic: 'linen versus cotton sheets',
      sections: ['Feel and temperature', 'Durability', 'Price over five years', 'Which to choose'],
      schemaTypes: ['Article', 'BreadcrumbList'],
      quality: 'strong',
      words: 1240,
      images: 2,
      externalLinks: 2,
      publishedDaysAgo: 260,
      linksTo: ['/products/linen-duvet-cover', '/pages/materials'],
      targetKeywords: ['linen vs cotton sheets'],
    },
    {
      path: '/blogs/journal/gots-certification-explained',
      pageType: 'ARTICLE',
      topic: 'GOTS certification',
      sections: ['What the standard covers', 'What it does not cover', 'How to verify a claim'],
      schemaTypes: ['Article'],
      quality: 'average',
      words: 780,
      externalLinks: 2,
      publishedDaysAgo: 190,
      linksTo: ['/pages/materials'],
      targetKeywords: ['gots certification explained'],
    },
    {
      path: '/blogs/journal/bedding-size-guide',
      pageType: 'ARTICLE',
      topic: 'bedding sizes and measurements',
      sections: ['Standard sizes', 'Measuring your mattress', 'Duvet drop'],
      // Deliberate: an old template with no viewport meta tag.
      noViewport: true,
      schemaTypes: ['Article'],
      quality: 'average',
      words: 690,
      images: 2,
      publishedDaysAgo: 330,
      linksTo: ['/products/stonewashed-sheet-set'],
      targetKeywords: ['bedding size guide'],
    },
    {
      path: '/blogs/journal/summer-bedding-edit',
      pageType: 'ARTICLE',
      topic: 'the summer bedding edit',
      sections: ['This season'],
      quality: 'weak',
      words: 185,
      schemaTypes: [],
      publishedDaysAgo: 120,
      linksTo: ['/collections/bedding'],
      targetKeywords: ['summer bedding'],
    },
    {
      path: '/policies/privacy-policy',
      pageType: 'LEGAL',
      topic: 'the Cedar & Sage privacy policy',
      sections: ['What we collect', 'Cookies', 'Your rights'],
      robotsMeta: 'noindex, follow',
      quality: 'average',
      words: 580,
      linksTo: ['/policies/refund-policy'],
    },
    {
      path: '/policies/refund-policy',
      pageType: 'LEGAL',
      topic: 'the Cedar & Sage refund policy',
      sections: ['Returns window', 'Condition', 'Refund timing'],
      robotsMeta: 'noindex, follow',
      quality: 'average',
      words: 520,
      linksTo: ['/policies/privacy-policy'],
    },
  ],
  queries: [
    { query: 'linen duvet cover', path: '/products/linen-duvet-cover', impressions: 980, position: 12.8, endPosition: 11.4, searchVolume: 14800 },
    { query: 'organic linen bedding', path: '/', impressions: 620, position: 8.9, endPosition: 8.1, searchVolume: 5400 },
    { query: 'how to wash linen sheets', path: '/blogs/journal/how-to-wash-linen-sheets', impressions: 1450, position: 3.4, ctrFactor: 0.41, searchVolume: 22000 },
    { query: 'linen vs cotton sheets', path: '/blogs/journal/linen-vs-cotton-sheets', impressions: 890, position: 5.6, searchVolume: 9900 },
    { query: 'stonewashed sheet set', path: '/products/stonewashed-sheet-set', impressions: 340, position: 14.6, searchVolume: 1300 },
    { query: 'organic cotton pillowcases', path: '/products/organic-cotton-pillowcases', impressions: 520, position: 16.9, endPosition: 15.2, searchVolume: 4400 },
    { query: 'waffle bath towel', path: '/products/waffle-bath-towel', impressions: 410, position: 10.2, searchVolume: 3600 },
    { query: 'gots certified bedding', path: '/pages/materials', impressions: 260, position: 9.7, searchVolume: 1600 },
    { query: 'gots certification explained', path: '/blogs/journal/gots-certification-explained', impressions: 190, position: 11.8, searchVolume: 880 },
    { query: 'bedding size guide', path: '/blogs/journal/bedding-size-guide', impressions: 720, position: 13.9, endPosition: 12.4, searchVolume: 8100 },
    { query: 'linen table runner', path: '/products/linen-table-runner', impressions: 230, position: 22.6, searchVolume: 2900 },
    { query: 'cedar and sage bedding', path: '/', impressions: 180, position: 1.4, branded: true, searchVolume: 210 },
    { query: 'cedar and sage returns', path: '/policies/refund-policy', impressions: 60, position: 2.1, branded: true, searchVolume: 70 },
    { query: 'european flax linen', path: '/pages/materials', impressions: 310, position: 17.4, searchVolume: 2400 },
    { query: 'linen care guide', path: '/pages/care-guide', impressions: 280, position: 8.6, searchVolume: 1900 },
    { query: 'summer bedding', path: '/blogs/journal/summer-bedding-edit', impressions: 340, position: 28.9, demandTrend: 0.55, searchVolume: 6600 },
    { query: 'stoneware mug set', path: '/products/ceramic-mug-set', impressions: 150, position: 19.7, searchVolume: 1000 },
    { query: 'organic bedding', path: '/collections/bedding', impressions: 640, position: 15.8, endPosition: 14.1, searchVolume: 12100 },
  ],
  aiPrompts: [
    {
      prompt: 'Which brands sell GOTS-certified organic linen bedding?',
      category: 'category discovery',
      mentionRate: 0.38,
      competitors: ['Meadowfold', 'Rye & Row', 'Halden Home'],
    },
    {
      prompt: 'Is linen or cotton better for hot sleepers?',
      category: 'informational',
      mentionRate: 0.21,
      competitors: ['Meadowfold'],
    },
    {
      prompt: 'How should I wash linen sheets so they last?',
      category: 'informational',
      mentionRate: 0.48,
      competitors: ['Halden Home'],
    },
    {
      prompt: 'Cedar & Sage bedding reviews',
      category: 'branded',
      mentionRate: 0.88,
      competitors: ['Rye & Row'],
    },
    {
      prompt: 'What does GOTS certification actually guarantee?',
      category: 'informational',
      mentionRate: 0.16,
      competitors: [],
    },
  ],
  facts: [
    { fact: 'Cedar & Sage linen is woven from European flax grown in Normandy and Belgium.', category: 'sourcing' },
    { fact: 'All cotton products carry GOTS certification, verified annually by the certifying body.', category: 'certification' },
    { fact: 'Returns are accepted for 45 days on unwashed items in the original packaging.', category: 'policy' },
    { fact: 'Orders ship from a single warehouse in Portland, Oregon, within two business days.', category: 'fulfilment' },
  ],
  knowledge: {
    toneOfVoice: 'Warm, concrete, unfussy. Describe the material, not a lifestyle.',
    brandStyle: 'Short paragraphs. Measurements in both metric and imperial. No aspirational filler.',
    preferredCta: 'Order a fabric swatch before buying a full set.',
    uniqueValueProps: [
      'European flax linen with a named growing region',
      'GOTS certification verified annually rather than claimed once',
      '45-day returns on unwashed items',
    ],
    prohibitedClaims: [
      'Never claim a product is hypoallergenic',
      'Never imply certification covers labour conditions it does not cover',
    ],
    writingGuidelines:
      'Say what the fabric does in use. Name the certification body when a certification is mentioned. Never invent a customer quote.',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. Content site — the neglected WordPress estate
// ─────────────────────────────────────────────────────────────────────────────

const TRAILHEAD: DemoSiteBlueprint = {
  key: 'trailhead',
  name: 'Trailhead Field Notes',
  domain: 'trailheadfieldnotes.example',
  brandName: 'Trailhead Field Notes',
  description: 'Independent backpacking guides and gear testing notes.',
  businessCategory: 'Content / affiliate — outdoor',
  targetAudience: 'Backpackers planning multi-day trips in North American mountain terrain.',
  readerNoun: 'backpackers',
  conversionGoal: 'Newsletter signup',
  cmsType: 'WORDPRESS',
  autonomyLevel: 'L0_INSIGHTS_ONLY',
  // Hobby content: reading peaks midweek evenings and again on Sunday planning sessions.
  weeklyShape: [1.14, 0.94, 1.02, 1.06, 1.0, 0.88, 0.96],
  // Deliberate: no robots.txt and no sitemap at all.
  robots: { found: false, disallow: [] },
  sitemap: { found: false, errors: [] },
  nav: ['/', '/guides', '/gear', '/about'],
  footer: [],
  pages: [
    {
      path: '/',
      pageType: 'HOMEPAGE',
      topic: 'backpacking guides and gear notes',
      sections: ['Latest field notes', 'Start here'],
      // Deliberate: no structured data anywhere on this site.
      schemaTypes: [],
      quality: 'average',
      words: 420,
      images: 3,
      imagesMissingAlt: 3,
      linksTo: ['/guides/backpacking-water-filters', '/gear/trekking-poles-review', '/guides/ultralight-tent-setup'],
      targetKeywords: ['backpacking guides'],
    },
    {
      path: '/guides',
      pageType: 'CATEGORY',
      topic: 'backpacking skills guides',
      sections: ['All guides'],
      schemaTypes: [],
      quality: 'weak',
      words: 210,
      linksTo: [
        '/guides/backpacking-water-filters',
        '/guides/ultralight-tent-setup',
        '/guides/hiking-nutrition-basics',
        '/guides/leave-no-trace',
        '/guides/trail-first-aid',
        '/guides/2019/07/12/trail-navigation-basics',
        '/guides/2018/11/03/winter-layering-system',
        '/archive/2017',
      ],
      targetKeywords: ['backpacking skills'],
    },
    {
      path: '/gear',
      pageType: 'CATEGORY',
      topic: 'backpacking gear testing notes',
      sections: ['All gear notes'],
      schemaTypes: [],
      quality: 'weak',
      words: 195,
      linksTo: [
        '/gear/trekking-poles-review',
        '/gear/best-sleeping-pads',
        '/gear/water-bottle-comparison',
        '/gear/affiliate-disclosure',
        // Two links still pointing at redirects.
        '/gear/old-boot-guide',
        '/gear/old-pack-guide',
      ],
      targetKeywords: ['backpacking gear reviews'],
    },
    {
      path: '/about',
      pageType: 'ABOUT',
      topic: 'who writes Trailhead Field Notes',
      sections: ['How we test'],
      schemaTypes: [],
      quality: 'weak',
      words: 240,
      targetKeywords: ['about trailhead field notes'],
    },
    {
      path: '/guides/backpacking-water-filters',
      pageType: 'ARTICLE',
      topic: 'backpacking water filters',
      sections: ['Filter types', 'Flow rate versus weight', 'Field maintenance', 'Cold-weather failure modes', 'What we carry'],
      schemaTypes: [],
      quality: 'strong',
      words: 1620,
      images: 6,
      imagesMissingAlt: 4,
      externalLinks: 2,
      // Deliberate: an enormous page from an unoptimised gallery plugin.
      contentBytes: 2_450_000,
      publishedDaysAgo: 380,
      updatedDaysAgo: 55,
      linksTo: ['/guides/hiking-nutrition-basics', '/gear/water-bottle-comparison'],
      targetKeywords: ['backpacking water filter'],
    },
    {
      path: '/guides/ultralight-tent-setup',
      pageType: 'ARTICLE',
      topic: 'ultralight tent setup',
      sections: ['Site selection', 'Pitching in wind', 'Condensation management'],
      schemaTypes: [],
      quality: 'average',
      words: 860,
      images: 4,
      imagesMissingAlt: 2,
      headingSkip: true,
      publishedDaysAgo: 300,
      linksTo: ['/gear/best-sleeping-pads'],
      targetKeywords: ['ultralight tent setup'],
    },
    {
      path: '/guides/hiking-nutrition-basics',
      pageType: 'ARTICLE',
      topic: 'hiking nutrition',
      sections: ['Calories per day', 'Carrying weight versus energy density', 'Resupply planning'],
      schemaTypes: [],
      quality: 'average',
      words: 910,
      images: 2,
      publishedDaysAgo: 260,
      linksTo: ['/guides/trail-first-aid'],
      targetKeywords: ['hiking nutrition'],
    },
    {
      path: '/guides/2019/07/12/trail-navigation-basics',
      pageType: 'ARTICLE',
      topic: 'trail navigation basics',
      sections: ['Map and compass', 'Using a GPS as a backup', 'Practising before the trip'],
      // Deliberate: the old date-based permalink structure, five levels deep.
      schemaTypes: [],
      quality: 'average',
      words: 780,
      publishedDaysAgo: 2200,
      targetKeywords: ['trail navigation basics'],
    },
    {
      path: '/guides/2018/11/03/winter-layering-system',
      pageType: 'ARTICLE',
      topic: 'a winter layering system',
      sections: ['Base layer', 'Insulation', 'Shell'],
      schemaTypes: [],
      quality: 'average',
      words: 720,
      publishedDaysAgo: 2500,
      targetKeywords: ['winter layering system'],
    },
    {
      path: '/guides/leave-no-trace',
      pageType: 'ARTICLE',
      topic: 'leave no trace practice',
      sections: ['The seven principles', 'Waste handling', 'Campsite selection'],
      // Deliberate: the template lost its lang attribute.
      noLang: true,
      schemaTypes: [],
      quality: 'average',
      words: 690,
      publishedDaysAgo: 210,
      targetKeywords: ['leave no trace'],
    },
    {
      path: '/guides/trail-first-aid',
      pageType: 'ARTICLE',
      topic: 'trail first aid',
      sections: ['Kit contents', 'Blister management', 'When to end the trip'],
      // Deliberate: a shared-host page that takes over three seconds to respond.
      responseTimeMs: 3400,
      schemaTypes: [],
      quality: 'average',
      words: 820,
      publishedDaysAgo: 170,
      targetKeywords: ['trail first aid kit'],
    },
    {
      path: '/guides/printable-checklist',
      pageType: 'OTHER',
      topic: 'the printable packing checklist',
      sections: ['Before you go'],
      robotsMeta: 'noindex, follow',
      schemaTypes: [],
      quality: 'weak',
      words: 160,
      inSitemap: false,
      targetKeywords: ['backpacking checklist'],
    },
    {
      path: '/gear/trekking-poles-review',
      pageType: 'ARTICLE',
      topic: 'trekking poles',
      sections: ['Locking mechanisms', 'Weight and packed length', 'Grip materials', 'Durability after 400 miles'],
      // Deliberate: 92 characters.
      title: 'The Complete Trekking Poles Review and Buying Guide for Backpackers in Mountain Terrain',
      schemaTypes: [],
      quality: 'average',
      words: 1040,
      images: 5,
      imagesMissingAlt: 5,
      publishedDaysAgo: 240,
      linksTo: ['/gear/affiliate-disclosure'],
      targetKeywords: ['trekking poles review'],
    },
    {
      path: '/gear/best-sleeping-pads',
      pageType: 'ARTICLE',
      topic: 'sleeping pads',
      sections: ['R-value'],
      // Deliberate: shares a title with the comparison page below.
      title: 'Gear Notes — Trailhead Field Notes',
      schemaTypes: [],
      quality: 'weak',
      words: 235,
      publishedDaysAgo: 140,
      targetKeywords: ['best sleeping pads'],
    },
    {
      path: '/gear/water-bottle-comparison',
      pageType: 'COMPARISON',
      topic: 'backpacking water bottles',
      sections: ['Weight per litre', 'Durability', 'Compatibility with filters'],
      title: 'Gear Notes — Trailhead Field Notes',
      schemaTypes: [],
      quality: 'average',
      words: 760,
      publishedDaysAgo: 160,
      linksTo: ['/guides/backpacking-water-filters'],
      targetKeywords: ['backpacking water bottle comparison'],
    },
    {
      path: '/gear/rain-jacket-guide',
      pageType: 'ARTICLE',
      topic: 'rain jackets for backpacking',
      sections: ['Membranes and coatings', 'Breathability trade-offs', 'Care and re-proofing'],
      schemaTypes: [],
      quality: 'average',
      words: 880,
      images: 3,
      publishedDaysAgo: 190,
      // Deliberate orphan: published but never linked from anywhere.
      targetKeywords: ['backpacking rain jacket'],
    },
    {
      path: '/gear/affiliate-disclosure',
      pageType: 'LEGAL',
      topic: 'the affiliate disclosure',
      sections: ['How links work', 'What we do not accept'],
      schemaTypes: [],
      quality: 'average',
      words: 380,
      targetKeywords: ['affiliate disclosure'],
    },
    {
      path: '/tag/backpacking',
      pageType: 'CATEGORY',
      topic: 'posts tagged backpacking',
      sections: ['Tagged posts'],
      // Deliberate: the tag template renders without nav or footer, so these three pages form a
      // component the rest of the site cannot reach.
      noChrome: true,
      h1: ['Browse by tag'],
      title: 'Tag archive',
      schemaTypes: [],
      quality: 'weak',
      words: 150,
      linksTo: ['/tag/gear-reviews', '/tag/trail-food'],
    },
    {
      path: '/tag/gear-reviews',
      pageType: 'CATEGORY',
      topic: 'posts tagged gear reviews',
      sections: ['Tagged posts'],
      noChrome: true,
      h1: ['Browse by tag'],
      title: 'Tag archive',
      schemaTypes: [],
      quality: 'weak',
      words: 150,
      linksTo: ['/tag/backpacking', '/tag/trail-food'],
    },
    {
      path: '/tag/trail-food',
      pageType: 'CATEGORY',
      topic: 'posts tagged trail food',
      sections: ['Tagged posts'],
      noChrome: true,
      h1: ['Browse by tag'],
      title: 'Tag archive',
      schemaTypes: [],
      quality: 'weak',
      words: 150,
      linksTo: ['/tag/backpacking'],
    },
    {
      path: '/archive/2017',
      pageType: 'OTHER',
      topic: 'the 2017 archive',
      sections: [],
      statusCode: 404,
      inSitemap: false,
    },
    {
      path: '/gear/old-boot-guide',
      pageType: 'ARTICLE',
      topic: 'the retired boot guide',
      sections: [],
      statusCode: 301,
      redirectTarget: '/gear/trekking-poles-review',
      redirectChain: ['/gear/old-boot-guide', '/gear/boots', '/gear/boot-guide', '/gear/trekking-poles-review'],
      inSitemap: false,
    },
    {
      path: '/gear/old-pack-guide',
      pageType: 'ARTICLE',
      topic: 'the retired pack guide',
      sections: [],
      statusCode: 301,
      redirectTarget: '/gear/best-sleeping-pads',
      redirectChain: ['/gear/old-pack-guide', '/gear/packs', '/gear/best-sleeping-pads'],
      inSitemap: false,
    },
  ],
  queries: [
    { query: 'backpacking water filter', path: '/guides/backpacking-water-filters', impressions: 1120, position: 6.4, endPosition: 7.9, demandTrend: 0.78, searchVolume: 18100 },
    { query: 'best backpacking water filter', path: '/guides/backpacking-water-filters', impressions: 860, position: 9.8, endPosition: 11.6, demandTrend: 0.72, searchVolume: 12100 },
    { query: 'ultralight tent setup', path: '/guides/ultralight-tent-setup', impressions: 320, position: 11.2, searchVolume: 1300 },
    { query: 'hiking nutrition', path: '/guides/hiking-nutrition-basics', impressions: 480, position: 13.7, searchVolume: 3600 },
    { query: 'trekking poles review', path: '/gear/trekking-poles-review', impressions: 740, position: 8.2, ctrFactor: 0.38, searchVolume: 9900 },
    { query: 'best sleeping pads', path: '/gear/best-sleeping-pads', impressions: 690, position: 24.3, demandTrend: 0.8, searchVolume: 22000 },
    { query: 'backpacking water bottle comparison', path: '/gear/water-bottle-comparison', impressions: 210, position: 15.9, searchVolume: 720 },
    { query: 'backpacking rain jacket', path: '/gear/rain-jacket-guide', impressions: 390, position: 19.4, searchVolume: 8100 },
    { query: 'trail navigation basics', path: '/guides/2019/07/12/trail-navigation-basics', impressions: 260, position: 17.8, searchVolume: 590 },
    { query: 'winter layering system', path: '/guides/2018/11/03/winter-layering-system', impressions: 180, position: 21.5, demandTrend: 0.65, searchVolume: 1000 },
    { query: 'leave no trace principles', path: '/guides/leave-no-trace', impressions: 540, position: 14.2, searchVolume: 14800 },
    { query: 'trail first aid kit', path: '/guides/trail-first-aid', impressions: 300, position: 12.9, searchVolume: 2400 },
    { query: 'trailhead field notes', path: '/', impressions: 70, position: 1.8, branded: true, searchVolume: 90 },
    { query: 'backpacking gear reviews', path: '/gear', impressions: 410, position: 26.7, demandTrend: 0.85, searchVolume: 12100 },
    { query: 'backpacking checklist', path: '/guides/printable-checklist', impressions: 120, position: 29.4, searchVolume: 9900 },
    { query: 'how to pitch a tent in wind', path: '/guides/ultralight-tent-setup', impressions: 150, position: 10.4, searchVolume: 480 },
  ],
  aiPrompts: [
    {
      prompt: 'What is the best water filter for multi-day backpacking trips?',
      category: 'category discovery',
      mentionRate: 0.18,
      competitors: ['Ridgeline Notes', 'Packlight Journal', 'Summit Test Lab'],
    },
    {
      prompt: 'How do I keep a water filter from freezing overnight?',
      category: 'informational',
      mentionRate: 0.24,
      competitors: ['Ridgeline Notes'],
    },
    {
      prompt: 'Which backpacking blogs actually test gear in the field?',
      category: 'category discovery',
      mentionRate: 0.09,
      competitors: ['Ridgeline Notes', 'Packlight Journal', 'Summit Test Lab', 'Bearfoot Reviews'],
    },
    {
      prompt: 'What are the seven Leave No Trace principles?',
      category: 'informational',
      mentionRate: 0.06,
      competitors: [],
    },
  ],
  facts: [
    { fact: 'Every gear note is based on at least 100 trail miles with the item, logged per trip.', category: 'methodology' },
    { fact: 'Trailhead Field Notes buys the gear it tests and does not accept review samples.', category: 'editorial' },
    { fact: 'Water filter flow rates are measured at 10°C from a two-litre reservoir, three runs averaged.', category: 'methodology' },
  ],
  knowledge: {
    toneOfVoice: 'First person, field-report register. Report what happened, including failures.',
    brandStyle: 'Measurements first. Never recommend gear that has not been carried.',
    preferredCta: 'Subscribe to the trip-report newsletter.',
    uniqueValueProps: [
      'Gear is bought, not sampled',
      'Every claim tied to a logged trail mileage',
      'Failure modes reported, not just the highlights',
    ],
    prohibitedClaims: [
      'Never present a spec sheet as a field test',
      'Never claim a product is the best without naming what it was compared against',
    ],
    writingGuidelines:
      'Open with the conditions the item was used in. Give the number before the adjective. Never invent a trip that did not happen.',
  },
};

export const DEMO_SITES: readonly DemoSiteBlueprint[] = [NORTHWIND, CEDAR_SAGE, TRAILHEAD];

/** Prefix applied to every demo website name so the UI can never present one as a real site. */
export const DEMO_NAME_PREFIX = '[DEMO] ';
