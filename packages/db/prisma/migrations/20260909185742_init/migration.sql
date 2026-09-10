-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('OWNER', 'ADMIN', 'EDITOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "WebsiteStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "CmsType" AS ENUM ('UNKNOWN', 'WORDPRESS', 'SHOPIFY', 'WEBFLOW', 'NEXTJS', 'ASTRO', 'HUGO', 'GHOST', 'SQUARESPACE', 'WIX', 'CUSTOM', 'GIT');

-- CreateEnum
CREATE TYPE "AutonomyLevel" AS ENUM ('L0_INSIGHTS_ONLY', 'L1_DRAFTS_ONLY', 'L2_SAFE_TECHNICAL', 'L3_MOST_REVERSIBLE', 'L4_HIGH_AUTONOMY');

-- CreateEnum
CREATE TYPE "IntegrationProvider" AS ENUM ('GOOGLE_SEARCH_CONSOLE', 'GOOGLE_ANALYTICS_4', 'BING_WEBMASTER', 'WORDPRESS', 'GIT', 'WEBHOOK', 'SHOPIFY', 'WEBFLOW');

-- CreateEnum
CREATE TYPE "IntegrationStatus" AS ENUM ('NOT_CONFIGURED', 'CONNECTED', 'ERROR', 'EXPIRED', 'DISABLED');

-- CreateEnum
CREATE TYPE "CrawlStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PageType" AS ENUM ('HOMEPAGE', 'ARTICLE', 'BLOG_INDEX', 'LANDING', 'PRODUCT', 'CATEGORY', 'COMPARISON', 'GLOSSARY', 'FAQ', 'ABOUT', 'CONTACT', 'LEGAL', 'AUTHOR', 'OTHER');

-- CreateEnum
CREATE TYPE "IssueSeverity" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO');

-- CreateEnum
CREATE TYPE "IssueStatus" AS ENUM ('OPEN', 'IGNORED', 'IN_PROGRESS', 'RESOLVED', 'REGRESSED');

-- CreateEnum
CREATE TYPE "IssueCategory" AS ENUM ('CRAWLABILITY', 'INDEXABILITY', 'METADATA', 'CONTENT', 'LINKS', 'ARCHITECTURE', 'STRUCTURED_DATA', 'PERFORMANCE', 'SECURITY', 'INTERNATIONAL', 'GEO');

-- CreateEnum
CREATE TYPE "SearchIntent" AS ENUM ('INFORMATIONAL', 'NAVIGATIONAL', 'COMMERCIAL', 'TRANSACTIONAL', 'LOCAL', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "FunnelStage" AS ENUM ('AWARENESS', 'CONSIDERATION', 'DECISION', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "KeywordSource" AS ENUM ('SEARCH_CONSOLE', 'BING', 'SITE_CONTENT', 'COMPETITOR', 'SERP_PROVIDER', 'AI_EXPANSION', 'MANUAL', 'CSV_IMPORT');

-- CreateEnum
CREATE TYPE "OpportunityType" AS ENUM ('IMPROVE_EXISTING_PAGE', 'NEW_ARTICLE', 'NEW_LANDING_PAGE', 'NEW_COMPARISON_PAGE', 'NEW_GLOSSARY_PAGE', 'NEW_PRODUCT_PAGE', 'ADD_FAQ_SECTION', 'CONTENT_REFRESH', 'CTR_OPTIMISATION', 'CONSOLIDATE_CANNIBALISATION', 'NO_ACTION');

-- CreateEnum
CREATE TYPE "OpportunityStatus" AS ENUM ('IDENTIFIED', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ContentStage" AS ENUM ('RESEARCH', 'INTENT_ANALYSIS', 'CANNIBALISATION_CHECK', 'COMPETITOR_ANALYSIS', 'BRIEF', 'OUTLINE', 'DRAFT', 'FACT_CHECK', 'SEO_OPTIMISATION', 'BRAND_REVIEW', 'INTERNAL_LINKING', 'STRUCTURED_DATA', 'QUALITY_REVIEW', 'READY_FOR_APPROVAL', 'APPROVED', 'PUBLISHED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ContentStageStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "SuggestionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'APPLIED', 'FAILED');

-- CreateEnum
CREATE TYPE "SchemaValidationStatus" AS ENUM ('VALID', 'WARNING', 'INVALID', 'UNVALIDATED');

-- CreateEnum
CREATE TYPE "DeploymentStatus" AS ENUM ('NOT_DEPLOYED', 'PENDING', 'DEPLOYED', 'FAILED');

-- CreateEnum
CREATE TYPE "EntityType" AS ENUM ('BRAND', 'WEBSITE', 'COMPANY', 'PRODUCT', 'SERVICE', 'PERSON', 'TOPIC', 'ORGANIZATION', 'LOCATION', 'SOFTWARE', 'FEATURE', 'EVENT', 'CONCEPT');

-- CreateEnum
CREATE TYPE "ActionType" AS ENUM ('FIX_TECHNICAL_ISSUE', 'UPDATE_TITLE', 'UPDATE_META_DESCRIPTION', 'UPDATE_CONTENT', 'PUBLISH_CONTENT', 'CREATE_CONTENT_BRIEF', 'ADD_INTERNAL_LINKS', 'ADD_STRUCTURED_DATA', 'CREATE_REDIRECT', 'REFRESH_CONTENT', 'CONSOLIDATE_PAGES', 'SUBMIT_URL_INDEXING', 'GEO_IMPROVEMENT', 'OUTREACH_DRAFT', 'CUSTOM');

-- CreateEnum
CREATE TYPE "ActionRisk" AS ENUM ('SAFE', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "ActionStatus" AS ENUM ('PROPOSED', 'QUEUED', 'AWAITING_APPROVAL', 'APPROVED', 'REJECTED', 'EXECUTING', 'COMPLETED', 'FAILED', 'ROLLED_BACK', 'CANCELLED', 'MEASURING', 'EVALUATED');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ExperimentStatus" AS ENUM ('RUNNING', 'COMPLETED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "ExperimentOutcome" AS ENUM ('PENDING', 'LIKELY_POSITIVE', 'INCONCLUSIVE', 'LIKELY_NEGATIVE');

-- CreateEnum
CREATE TYPE "AgentRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'DELAYED');

-- CreateEnum
CREATE TYPE "NotificationSeverity" AS ENUM ('INFO', 'SUCCESS', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "EmbeddingOwner" AS ENUM ('PAGE', 'KEYWORD', 'CLUSTER', 'ENTITY', 'DRAFT');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'OWNER',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "ip" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Website" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "protocol" TEXT NOT NULL DEFAULT 'https',
    "status" "WebsiteStatus" NOT NULL DEFAULT 'ACTIVE',
    "description" TEXT,
    "businessCategory" TEXT,
    "targetAudience" TEXT,
    "conversionGoal" TEXT,
    "brandName" TEXT,
    "cmsType" "CmsType" NOT NULL DEFAULT 'UNKNOWN',
    "primaryLanguage" TEXT NOT NULL DEFAULT 'en',
    "targetLocales" TEXT[] DEFAULT ARRAY['en-US']::TEXT[],
    "targetCountry" TEXT NOT NULL DEFAULT 'USA',
    "faviconUrl" TEXT,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "healthScore" DOUBLE PRECISION,
    "geoScore" DOUBLE PRECISION,
    "aiVisibilityScore" DOUBLE PRECISION,
    "contentScore" DOUBLE PRECISION,
    "lastCrawlAt" TIMESTAMP(3),
    "lastAnalysisAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Website_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebsiteSettings" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "crawlMaxPages" INTEGER NOT NULL DEFAULT 1000,
    "crawlMaxDepth" INTEGER NOT NULL DEFAULT 10,
    "crawlConcurrency" INTEGER NOT NULL DEFAULT 4,
    "crawlDelayMs" INTEGER NOT NULL DEFAULT 250,
    "crawlUserAgent" TEXT NOT NULL DEFAULT 'SEO-OS-Bot/1.0 (+https://github.com/seo-os)',
    "crawlRespectRobots" BOOLEAN NOT NULL DEFAULT true,
    "crawlRenderJs" BOOLEAN NOT NULL DEFAULT false,
    "crawlIncludePatterns" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "crawlExcludePatterns" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "crawlTimeoutMs" INTEGER NOT NULL DEFAULT 20000,
    "autonomyLevel" "AutonomyLevel" NOT NULL DEFAULT 'L1_DRAFTS_ONLY',
    "autoApproveSafe" BOOLEAN NOT NULL DEFAULT false,
    "reasoningModel" TEXT,
    "fastModel" TEXT,
    "writingModel" TEXT,
    "embeddingModel" TEXT,
    "aiProvider" TEXT,
    "monthlyAiBudgetUsd" DOUBLE PRECISION,
    "scheduleCrawl" TEXT DEFAULT '0 3 * * 1',
    "scheduleGscSync" TEXT DEFAULT '0 5 * * *',
    "scheduleAnalysis" TEXT DEFAULT '0 6 * * *',
    "scheduleAiVisibility" TEXT DEFAULT '0 7 * * 1',
    "scheduleReport" TEXT DEFAULT '0 8 * * 1',
    "thinContentWords" INTEGER NOT NULL DEFAULT 300,
    "ctrOpportunityMinImpressions" INTEGER NOT NULL DEFAULT 100,
    "strikingDistanceMin" DOUBLE PRECISION NOT NULL DEFAULT 8,
    "strikingDistanceMax" DOUBLE PRECISION NOT NULL DEFAULT 20,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebsiteSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeBase" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "businessDescription" TEXT,
    "products" JSONB DEFAULT '[]',
    "audience" TEXT,
    "toneOfVoice" TEXT,
    "brandStyle" TEXT,
    "terminology" JSONB DEFAULT '[]',
    "preferredCta" TEXT,
    "prohibitedClaims" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "writingGuidelines" TEXT,
    "uniqueValueProps" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "authorBios" JSONB DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeBase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrandFact" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "fact" TEXT NOT NULL,
    "category" TEXT,
    "source" TEXT NOT NULL DEFAULT 'internal',
    "sourceUrl" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrandFact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Integration" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "status" "IntegrationStatus" NOT NULL DEFAULT 'NOT_CONFIGURED',
    "credentials" TEXT,
    "config" JSONB DEFAULT '{}',
    "accountEmail" TEXT,
    "externalId" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncStatus" TEXT,
    "lastError" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Integration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Crawl" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "status" "CrawlStatus" NOT NULL DEFAULT 'QUEUED',
    "trigger" TEXT NOT NULL DEFAULT 'manual',
    "maxPages" INTEGER NOT NULL,
    "maxDepth" INTEGER NOT NULL,
    "renderJs" BOOLEAN NOT NULL DEFAULT false,
    "userAgent" TEXT,
    "pagesDiscovered" INTEGER NOT NULL DEFAULT 0,
    "pagesCrawled" INTEGER NOT NULL DEFAULT 0,
    "pagesFailed" INTEGER NOT NULL DEFAULT 0,
    "issuesFound" INTEGER NOT NULL DEFAULT 0,
    "robotsTxtFound" BOOLEAN NOT NULL DEFAULT false,
    "robotsTxtBody" TEXT,
    "sitemapUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sitemapUrlCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "error" TEXT,
    "progressMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Crawl_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrawlPage" (
    "id" TEXT NOT NULL,
    "crawlId" TEXT NOT NULL,
    "pageId" TEXT,
    "url" TEXT NOT NULL,
    "normalizedUrl" TEXT NOT NULL,
    "statusCode" INTEGER,
    "contentType" TEXT,
    "redirectTarget" TEXT,
    "redirectChain" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "depth" INTEGER NOT NULL DEFAULT 0,
    "responseTimeMs" INTEGER,
    "contentBytes" INTEGER,
    "error" TEXT,
    "title" TEXT,
    "titleLength" INTEGER,
    "metaDescription" TEXT,
    "metaDescriptionLength" INTEGER,
    "canonicalUrl" TEXT,
    "robotsMeta" TEXT,
    "xRobotsTag" TEXT,
    "metaViewport" TEXT,
    "lang" TEXT,
    "h1" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "headings" JSONB DEFAULT '[]',
    "wordCount" INTEGER NOT NULL DEFAULT 0,
    "textContent" TEXT,
    "contentHash" TEXT,
    "simhash" TEXT,
    "internalLinkCount" INTEGER NOT NULL DEFAULT 0,
    "externalLinkCount" INTEGER NOT NULL DEFAULT 0,
    "imageCount" INTEGER NOT NULL DEFAULT 0,
    "imagesMissingAlt" INTEGER NOT NULL DEFAULT 0,
    "schemaTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "structuredData" JSONB DEFAULT '[]',
    "hreflang" JSONB DEFAULT '[]',
    "openGraph" JSONB DEFAULT '{}',
    "isIndexable" BOOLEAN NOT NULL DEFAULT true,
    "indexabilityReason" TEXT,
    "inSitemap" BOOLEAN NOT NULL DEFAULT false,
    "crawledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrawlPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LinkEdge" (
    "id" TEXT NOT NULL,
    "crawlId" TEXT NOT NULL,
    "sourceCrawlPageId" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "targetUrl" TEXT NOT NULL,
    "normalizedTarget" TEXT NOT NULL,
    "anchorText" TEXT,
    "rel" TEXT,
    "isInternal" BOOLEAN NOT NULL DEFAULT true,
    "isNofollow" BOOLEAN NOT NULL DEFAULT false,
    "inNav" BOOLEAN NOT NULL DEFAULT false,
    "inFooter" BOOLEAN NOT NULL DEFAULT false,
    "inMainContent" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "LinkEdge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Page" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "normalizedUrl" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "pageType" "PageType" NOT NULL DEFAULT 'OTHER',
    "title" TEXT,
    "metaDescription" TEXT,
    "h1" TEXT,
    "canonicalUrl" TEXT,
    "lang" TEXT,
    "wordCount" INTEGER NOT NULL DEFAULT 0,
    "statusCode" INTEGER,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "isIndexable" BOOLEAN NOT NULL DEFAULT true,
    "indexabilityReason" TEXT,
    "inSitemap" BOOLEAN NOT NULL DEFAULT false,
    "contentHash" TEXT,
    "schemaTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "internalLinksIn" INTEGER NOT NULL DEFAULT 0,
    "internalLinksOut" INTEGER NOT NULL DEFAULT 0,
    "externalLinksOut" INTEGER NOT NULL DEFAULT 0,
    "isOrphan" BOOLEAN NOT NULL DEFAULT false,
    "clicks28d" INTEGER NOT NULL DEFAULT 0,
    "impressions28d" INTEGER NOT NULL DEFAULT 0,
    "ctr28d" DOUBLE PRECISION,
    "position28d" DOUBLE PRECISION,
    "clicksPrev28d" INTEGER NOT NULL DEFAULT 0,
    "impressionsPrev28d" INTEGER NOT NULL DEFAULT 0,
    "positionPrev28d" DOUBLE PRECISION,
    "clicksTrendPct" DOUBLE PRECISION,
    "seoScore" DOUBLE PRECISION,
    "geoScore" DOUBLE PRECISION,
    "opportunityScore" DOUBLE PRECISION,
    "contentScore" DOUBLE PRECISION,
    "readabilityScore" DOUBLE PRECISION,
    "publishedAt" TIMESTAMP(3),
    "contentUpdatedAt" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastCrawledAt" TIMESTAMP(3),
    "lastAnalysedAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Page_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PageSnapshot" (
    "id" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "title" TEXT,
    "metaDescription" TEXT,
    "h1" TEXT,
    "wordCount" INTEGER NOT NULL DEFAULT 0,
    "contentHash" TEXT,
    "textContent" TEXT,
    "headings" JSONB DEFAULT '[]',
    "statusCode" INTEGER,
    "seoScore" DOUBLE PRECISION,
    "geoScore" DOUBLE PRECISION,
    "clicks28d" INTEGER,
    "impressions28d" INTEGER,
    "position28d" DOUBLE PRECISION,
    "reason" TEXT NOT NULL DEFAULT 'crawl',
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PageSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TechnicalIssue" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "crawlId" TEXT,
    "pageId" TEXT,
    "ruleId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" "IssueCategory" NOT NULL,
    "severity" "IssueSeverity" NOT NULL,
    "status" "IssueStatus" NOT NULL DEFAULT 'OPEN',
    "url" TEXT,
    "description" TEXT NOT NULL,
    "recommendation" TEXT NOT NULL,
    "evidence" JSONB DEFAULT '{}',
    "estimatedImpact" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
    "autoFixable" BOOLEAN NOT NULL DEFAULT false,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "fingerprint" TEXT NOT NULL,
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "ignoredAt" TIMESTAMP(3),
    "ignoredReason" TEXT,

    CONSTRAINT "TechnicalIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SearchConsoleDaily" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'gsc',
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "ctr" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "position" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "country" TEXT,
    "device" TEXT,

    CONSTRAINT "SearchConsoleDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GscQueryMetric" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "pageId" TEXT,
    "keywordId" TEXT,
    "date" DATE NOT NULL,
    "query" TEXT NOT NULL,
    "page" TEXT NOT NULL,
    "country" TEXT,
    "device" TEXT,
    "source" TEXT NOT NULL DEFAULT 'gsc',
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "ctr" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "position" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "GscQueryMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Keyword" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "clusterId" TEXT,
    "pageId" TEXT,
    "keyword" TEXT NOT NULL,
    "normalized" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en-US',
    "language" TEXT NOT NULL DEFAULT 'en',
    "country" TEXT NOT NULL DEFAULT 'USA',
    "intent" "SearchIntent" NOT NULL DEFAULT 'UNKNOWN',
    "funnelStage" "FunnelStage" NOT NULL DEFAULT 'UNKNOWN',
    "source" "KeywordSource" NOT NULL DEFAULT 'SEARCH_CONSOLE',
    "isTracked" BOOLEAN NOT NULL DEFAULT false,
    "isBranded" BOOLEAN NOT NULL DEFAULT false,
    "searchVolume" INTEGER,
    "difficulty" DOUBLE PRECISION,
    "cpc" DOUBLE PRECISION,
    "competition" DOUBLE PRECISION,
    "volumeSource" TEXT,
    "currentPosition" DOUBLE PRECISION,
    "bestPosition" DOUBLE PRECISION,
    "previousPosition" DOUBLE PRECISION,
    "positionChange" DOUBLE PRECISION,
    "rankingUrl" TEXT,
    "clicks28d" INTEGER NOT NULL DEFAULT 0,
    "impressions28d" INTEGER NOT NULL DEFAULT 0,
    "ctr28d" DOUBLE PRECISION,
    "position28d" DOUBLE PRECISION,
    "relevanceScore" DOUBLE PRECISION,
    "businessValue" DOUBLE PRECISION,
    "opportunityScore" DOUBLE PRECISION,
    "opportunityReason" TEXT,
    "opportunityFactors" JSONB DEFAULT '{}',
    "geoPotential" DOUBLE PRECISION,
    "isContentGap" BOOLEAN NOT NULL DEFAULT false,
    "hasCannibalization" BOOLEAN NOT NULL DEFAULT false,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Keyword_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KeywordMetric" (
    "id" TEXT NOT NULL,
    "keywordId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "searchVolume" INTEGER,
    "difficulty" DOUBLE PRECISION,
    "cpc" DOUBLE PRECISION,
    "clicks" INTEGER,
    "impressions" INTEGER,
    "ctr" DOUBLE PRECISION,
    "position" DOUBLE PRECISION,
    "source" TEXT NOT NULL DEFAULT 'gsc',

    CONSTRAINT "KeywordMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KeywordCluster" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "parentTopic" TEXT,
    "pillarPageId" TEXT,
    "intent" "SearchIntent" NOT NULL DEFAULT 'UNKNOWN',
    "keywordCount" INTEGER NOT NULL DEFAULT 0,
    "totalVolume" INTEGER NOT NULL DEFAULT 0,
    "totalImpressions" INTEGER NOT NULL DEFAULT 0,
    "totalClicks" INTEGER NOT NULL DEFAULT 0,
    "avgPosition" DOUBLE PRECISION,
    "coverageScore" DOUBLE PRECISION,
    "opportunityScore" DOUBLE PRECISION,
    "centroid" DOUBLE PRECISION[] DEFAULT ARRAY[]::DOUBLE PRECISION[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KeywordCluster_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ranking" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "keywordId" TEXT NOT NULL,
    "pageId" TEXT,
    "date" DATE NOT NULL,
    "position" DOUBLE PRECISION NOT NULL,
    "url" TEXT,
    "source" TEXT NOT NULL DEFAULT 'gsc',
    "device" TEXT NOT NULL DEFAULT 'desktop',
    "country" TEXT,
    "serpFeatures" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "Ranking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Competitor" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "name" TEXT,
    "isManual" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "sharedKeywords" INTEGER NOT NULL DEFAULT 0,
    "gapKeywords" INTEGER NOT NULL DEFAULT 0,
    "estimatedKeywords" INTEGER NOT NULL DEFAULT 0,
    "serpOverlapPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avgPosition" DOUBLE PRECISION,
    "topicalStrengths" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "contentVelocity" DOUBLE PRECISION,
    "lastAnalysedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Competitor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompetitorKeyword" (
    "id" TEXT NOT NULL,
    "competitorId" TEXT NOT NULL,
    "keywordId" TEXT,
    "keyword" TEXT NOT NULL,
    "position" DOUBLE PRECISION,
    "url" TEXT,
    "ourPosition" DOUBLE PRECISION,
    "isGap" BOOLEAN NOT NULL DEFAULT false,
    "gapScore" DOUBLE PRECISION,
    "estimatedVolume" INTEGER,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompetitorKeyword_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompetitorPage" (
    "id" TEXT NOT NULL,
    "competitorId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT,
    "estimatedTraffic" INTEGER,
    "keywordCount" INTEGER NOT NULL DEFAULT 0,
    "topics" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompetitorPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SerpSnapshot" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "keywordId" TEXT,
    "query" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en-US',
    "device" TEXT NOT NULL DEFAULT 'desktop',
    "provider" TEXT NOT NULL,
    "results" JSONB NOT NULL DEFAULT '[]',
    "peopleAlsoAsk" JSONB NOT NULL DEFAULT '[]',
    "relatedSearches" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "featuredSnippet" JSONB,
    "resultTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ourPosition" DOUBLE PRECISION,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SerpSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentOpportunity" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "pageId" TEXT,
    "keywordId" TEXT,
    "clusterId" TEXT,
    "type" "OpportunityType" NOT NULL,
    "status" "OpportunityStatus" NOT NULL DEFAULT 'IDENTIFIED',
    "title" TEXT NOT NULL,
    "targetKeyword" TEXT,
    "secondaryKeywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "suggestedUrl" TEXT,
    "reasoning" TEXT NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "impactScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "effortScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "confidenceScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "priorityScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "estimatedTrafficGain" INTEGER,
    "cannibalizationChecked" BOOLEAN NOT NULL DEFAULT false,
    "cannibalizationRisk" DOUBLE PRECISION,
    "existingPageMatch" TEXT,
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "ContentOpportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentBrief" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "opportunityId" TEXT,
    "title" TEXT NOT NULL,
    "targetKeyword" TEXT NOT NULL,
    "secondaryKeywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "intent" "SearchIntent" NOT NULL DEFAULT 'UNKNOWN',
    "funnelStage" "FunnelStage" NOT NULL DEFAULT 'UNKNOWN',
    "audience" TEXT,
    "suggestedUrl" TEXT,
    "titleIdeas" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metaDescription" TEXT,
    "outline" JSONB NOT NULL DEFAULT '[]',
    "entities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "questions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "competitorWeaknesses" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "originalAngle" TEXT,
    "supportingEvidence" JSONB NOT NULL DEFAULT '[]',
    "internalLinkTargets" JSONB NOT NULL DEFAULT '[]',
    "schemaOpportunity" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cta" TEXT,
    "geoRecommendations" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "targetWordCount" INTEGER,
    "serpAnalysis" JSONB DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentBrief_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentDraft" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "briefId" TEXT,
    "pageId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'NEW',
    "title" TEXT NOT NULL,
    "slug" TEXT,
    "metaTitle" TEXT,
    "metaDescription" TEXT,
    "bodyMarkdown" TEXT NOT NULL DEFAULT '',
    "bodyHtml" TEXT,
    "excerpt" TEXT,
    "targetKeyword" TEXT,
    "wordCount" INTEGER NOT NULL DEFAULT 0,
    "stage" "ContentStage" NOT NULL DEFAULT 'RESEARCH',
    "currentStageStatus" "ContentStageStatus" NOT NULL DEFAULT 'PENDING',
    "seoScore" DOUBLE PRECISION,
    "geoScore" DOUBLE PRECISION,
    "readabilityScore" DOUBLE PRECISION,
    "qualityScore" DOUBLE PRECISION,
    "keywordCoverage" JSONB DEFAULT '{}',
    "qualityFlags" JSONB NOT NULL DEFAULT '[]',
    "unverifiedClaims" JSONB NOT NULL DEFAULT '[]',
    "sources" JSONB NOT NULL DEFAULT '[]',
    "internalLinks" JSONB NOT NULL DEFAULT '[]',
    "structuredData" JSONB,
    "scheduledFor" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "publishedUrl" TEXT,
    "externalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentStageRun" (
    "id" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "stage" "ContentStage" NOT NULL,
    "status" "ContentStageStatus" NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "input" JSONB DEFAULT '{}',
    "output" JSONB DEFAULT '{}',
    "notes" TEXT,
    "error" TEXT,
    "agentRunId" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentStageRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentVersion" (
    "id" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "bodyMarkdown" TEXT NOT NULL,
    "metaTitle" TEXT,
    "metaDescription" TEXT,
    "authorType" TEXT NOT NULL DEFAULT 'ai',
    "authorName" TEXT,
    "changeSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InternalLinkSuggestion" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "sourcePageId" TEXT NOT NULL,
    "targetPageId" TEXT NOT NULL,
    "anchorText" TEXT NOT NULL,
    "placementHint" TEXT,
    "contextSnippet" TEXT,
    "reason" TEXT NOT NULL,
    "relevanceScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "impactScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" "SuggestionStatus" NOT NULL DEFAULT 'PENDING',
    "appliedAt" TIMESTAMP(3),
    "rejectedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InternalLinkSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StructuredDataItem" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "pageId" TEXT,
    "schemaType" TEXT NOT NULL,
    "jsonLd" JSONB NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'generated',
    "validationStatus" "SchemaValidationStatus" NOT NULL DEFAULT 'UNVALIDATED',
    "validationErrors" JSONB NOT NULL DEFAULT '[]',
    "deploymentStatus" "DeploymentStatus" NOT NULL DEFAULT 'NOT_DEPLOYED',
    "deployedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StructuredDataItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Entity" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "EntityType" NOT NULL,
    "description" TEXT,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sameAs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "canonicalUrl" TEXT,
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "mentionCount" INTEGER NOT NULL DEFAULT 0,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL DEFAULT 'ai',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Entity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EntityRelationship" (
    "id" TEXT NOT NULL,
    "fromId" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "relation" TEXT NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "evidence" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EntityRelationship_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GeoAudit" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "overallScore" DOUBLE PRECISION NOT NULL,
    "dimensions" JSONB NOT NULL DEFAULT '{}',
    "findings" JSONB NOT NULL DEFAULT '[]',
    "recommendations" JSONB NOT NULL DEFAULT '[]',
    "pagesAudited" INTEGER NOT NULL DEFAULT 0,
    "method" TEXT NOT NULL DEFAULT 'deterministic+llm',
    "summary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GeoAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GeoPageAudit" (
    "id" TEXT NOT NULL,
    "auditId" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "dimensions" JSONB NOT NULL DEFAULT '{}',
    "findings" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "GeoPageAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiVisibilityPrompt" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "category" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'en-US',
    "priority" INTEGER NOT NULL DEFAULT 50,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT NOT NULL DEFAULT 'ai',
    "expectedBrand" TEXT,
    "mentionRate" DOUBLE PRECISION,
    "citationRate" DOUBLE PRECISION,
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiVisibilityPrompt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiVisibilityRun" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "promptId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT,
    "method" TEXT NOT NULL DEFAULT 'api',
    "answerText" TEXT NOT NULL,
    "brandMentioned" BOOLEAN NOT NULL DEFAULT false,
    "brandPosition" INTEGER,
    "brandSentiment" TEXT,
    "citedUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ourUrlsCited" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "competitorsMentioned" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.6,
    "tokensUsed" INTEGER,
    "costUsd" DOUBLE PRECISION,
    "error" TEXT,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiVisibilityRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiVisibilityMention" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "entityName" TEXT NOT NULL,
    "isOurBrand" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER,
    "context" TEXT,
    "sentiment" TEXT,
    "citedUrl" TEXT,

    CONSTRAINT "AiVisibilityMention_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Backlink" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "referringDomain" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "targetUrl" TEXT NOT NULL,
    "anchorText" TEXT,
    "isFollow" BOOLEAN NOT NULL DEFAULT true,
    "domainAuthority" DOUBLE PRECISION,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lostAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "isSuspicious" BOOLEAN NOT NULL DEFAULT false,
    "provider" TEXT NOT NULL DEFAULT 'csv',

    CONSTRAINT "Backlink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeoAction" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "type" "ActionType" NOT NULL,
    "title" TEXT NOT NULL,
    "status" "ActionStatus" NOT NULL DEFAULT 'PROPOSED',
    "risk" "ActionRisk" NOT NULL DEFAULT 'SAFE',
    "reasoning" TEXT NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "affectedUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requiredAgent" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "impactScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "effortScore" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "confidenceScore" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "businessValue" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "riskScore" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "priorityScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "priorityFactors" JSONB NOT NULL DEFAULT '{}',
    "sourceType" TEXT,
    "sourceId" TEXT,
    "autoExecutable" BOOLEAN NOT NULL DEFAULT false,
    "proposedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "measureAfter" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeoAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActionExecution" (
    "id" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "adapter" TEXT,
    "request" JSONB DEFAULT '{}',
    "response" JSONB DEFAULT '{}',
    "beforeState" JSONB DEFAULT '{}',
    "afterState" JSONB DEFAULT '{}',
    "rollbackData" JSONB DEFAULT '{}',
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,

    CONSTRAINT "ActionExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "actionId" TEXT,
    "userId" TEXT,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "risk" "ActionRisk" NOT NULL DEFAULT 'SAFE',
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "diff" JSONB DEFAULT '{}',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "editedPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Experiment" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "actionId" TEXT,
    "pageId" TEXT,
    "name" TEXT NOT NULL,
    "hypothesis" TEXT,
    "metric" TEXT NOT NULL DEFAULT 'clicks',
    "status" "ExperimentStatus" NOT NULL DEFAULT 'RUNNING',
    "outcome" "ExperimentOutcome" NOT NULL DEFAULT 'PENDING',
    "changeSummary" TEXT,
    "beforeState" JSONB NOT NULL DEFAULT '{}',
    "afterState" JSONB NOT NULL DEFAULT '{}',
    "baselineStart" TIMESTAMP(3) NOT NULL,
    "baselineEnd" TIMESTAMP(3) NOT NULL,
    "measureStart" TIMESTAMP(3) NOT NULL,
    "measureEnd" TIMESTAMP(3),
    "minDays" INTEGER NOT NULL DEFAULT 28,
    "baselineMetrics" JSONB DEFAULT '{}',
    "resultMetrics" JSONB DEFAULT '{}',
    "deltaPct" DOUBLE PRECISION,
    "significance" DOUBLE PRECISION,
    "interpretation" TEXT,
    "evaluatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Experiment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChangeLog" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "actionId" TEXT,
    "userId" TEXT,
    "actor" TEXT NOT NULL,
    "agent" TEXT,
    "changeType" TEXT NOT NULL,
    "targetUrl" TEXT,
    "summary" TEXT NOT NULL,
    "beforeState" JSONB DEFAULT '{}',
    "afterState" JSONB DEFAULT '{}',
    "reason" TEXT,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "rollbackable" BOOLEAN NOT NULL DEFAULT false,
    "rolledBackAt" TIMESTAMP(3),
    "resultMetrics" JSONB DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChangeLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "agent" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'manual',
    "status" "AgentRunStatus" NOT NULL DEFAULT 'RUNNING',
    "input" JSONB NOT NULL DEFAULT '{}',
    "output" JSONB DEFAULT '{}',
    "summary" TEXT,
    "toolCalls" JSONB NOT NULL DEFAULT '[]',
    "confidence" DOUBLE PRECISION,
    "actionsCreated" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "provider" TEXT,
    "model" TEXT,
    "tokensIn" INTEGER,
    "tokensOut" INTEGER,
    "costUsd" DOUBLE PRECISION,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiUsage" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "agent" TEXT,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "latencyMs" INTEGER,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobRecord" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT,
    "queue" TEXT NOT NULL,
    "jobName" TEXT NOT NULL,
    "jobId" TEXT,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "progressMessage" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB DEFAULT '{}',
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledJob" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT,
    "name" TEXT NOT NULL,
    "queue" TEXT NOT NULL,
    "jobName" TEXT NOT NULL,
    "cron" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "summary" TEXT,
    "highlights" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT,
    "userId" TEXT,
    "type" TEXT NOT NULL,
    "severity" "NotificationSeverity" NOT NULL DEFAULT 'INFO',
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "link" TEXT,
    "data" JSONB NOT NULL DEFAULT '{}',
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMP(3),
    "dedupeKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScoreSnapshot" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "healthScore" DOUBLE PRECISION,
    "geoScore" DOUBLE PRECISION,
    "aiVisibilityScore" DOUBLE PRECISION,
    "contentScore" DOUBLE PRECISION,
    "openIssues" INTEGER NOT NULL DEFAULT 0,
    "criticalIssues" INTEGER NOT NULL DEFAULT 0,
    "indexablePages" INTEGER NOT NULL DEFAULT 0,
    "orphanPages" INTEGER NOT NULL DEFAULT 0,
    "keywordsTop3" INTEGER NOT NULL DEFAULT 0,
    "keywordsTop10" INTEGER NOT NULL DEFAULT 0,
    "keywordsTop100" INTEGER NOT NULL DEFAULT 0,
    "clicks28d" INTEGER NOT NULL DEFAULT 0,
    "impressions28d" INTEGER NOT NULL DEFAULT 0,
    "avgPosition" DOUBLE PRECISION,

    CONSTRAINT "ScoreSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StrategyPlan" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "periodLabel" TEXT NOT NULL,
    "situation" TEXT NOT NULL,
    "biggestProblems" JSONB NOT NULL DEFAULT '[]',
    "biggestOpportunities" JSONB NOT NULL DEFAULT '[]',
    "strategy" TEXT NOT NULL,
    "today" JSONB NOT NULL DEFAULT '[]',
    "thisWeek" JSONB NOT NULL DEFAULT '[]',
    "thisMonth" JSONB NOT NULL DEFAULT '[]',
    "observedResults" JSONB NOT NULL DEFAULT '[]',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.6,
    "agentRunId" TEXT,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StrategyPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmbeddingRecord" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "ownerType" "EmbeddingOwner" NOT NULL,
    "pageId" TEXT,
    "keywordId" TEXT,
    "ownerId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "dimensions" INTEGER NOT NULL,
    "vector" DOUBLE PRECISION[],
    "textHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmbeddingRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_email_idx" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "Website_userId_status_idx" ON "Website"("userId", "status");

-- CreateIndex
CREATE INDEX "Website_domain_idx" ON "Website"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "Website_userId_domain_key" ON "Website"("userId", "domain");

-- CreateIndex
CREATE UNIQUE INDEX "WebsiteSettings_websiteId_key" ON "WebsiteSettings"("websiteId");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeBase_websiteId_key" ON "KnowledgeBase"("websiteId");

-- CreateIndex
CREATE INDEX "BrandFact_websiteId_verified_idx" ON "BrandFact"("websiteId", "verified");

-- CreateIndex
CREATE INDEX "Integration_provider_status_idx" ON "Integration"("provider", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Integration_websiteId_provider_key" ON "Integration"("websiteId", "provider");

-- CreateIndex
CREATE INDEX "Crawl_websiteId_createdAt_idx" ON "Crawl"("websiteId", "createdAt");

-- CreateIndex
CREATE INDEX "Crawl_status_idx" ON "Crawl"("status");

-- CreateIndex
CREATE INDEX "CrawlPage_crawlId_statusCode_idx" ON "CrawlPage"("crawlId", "statusCode");

-- CreateIndex
CREATE INDEX "CrawlPage_pageId_idx" ON "CrawlPage"("pageId");

-- CreateIndex
CREATE INDEX "CrawlPage_contentHash_idx" ON "CrawlPage"("contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "CrawlPage_crawlId_normalizedUrl_key" ON "CrawlPage"("crawlId", "normalizedUrl");

-- CreateIndex
CREATE INDEX "LinkEdge_crawlId_normalizedTarget_idx" ON "LinkEdge"("crawlId", "normalizedTarget");

-- CreateIndex
CREATE INDEX "LinkEdge_sourceCrawlPageId_idx" ON "LinkEdge"("sourceCrawlPageId");

-- CreateIndex
CREATE INDEX "LinkEdge_crawlId_isInternal_idx" ON "LinkEdge"("crawlId", "isInternal");

-- CreateIndex
CREATE INDEX "Page_websiteId_isActive_idx" ON "Page"("websiteId", "isActive");

-- CreateIndex
CREATE INDEX "Page_websiteId_opportunityScore_idx" ON "Page"("websiteId", "opportunityScore");

-- CreateIndex
CREATE INDEX "Page_websiteId_isOrphan_idx" ON "Page"("websiteId", "isOrphan");

-- CreateIndex
CREATE INDEX "Page_websiteId_pageType_idx" ON "Page"("websiteId", "pageType");

-- CreateIndex
CREATE UNIQUE INDEX "Page_websiteId_normalizedUrl_key" ON "Page"("websiteId", "normalizedUrl");

-- CreateIndex
CREATE INDEX "PageSnapshot_pageId_capturedAt_idx" ON "PageSnapshot"("pageId", "capturedAt");

-- CreateIndex
CREATE INDEX "TechnicalIssue_websiteId_status_severity_idx" ON "TechnicalIssue"("websiteId", "status", "severity");

-- CreateIndex
CREATE INDEX "TechnicalIssue_websiteId_category_idx" ON "TechnicalIssue"("websiteId", "category");

-- CreateIndex
CREATE INDEX "TechnicalIssue_websiteId_ruleId_idx" ON "TechnicalIssue"("websiteId", "ruleId");

-- CreateIndex
CREATE UNIQUE INDEX "TechnicalIssue_websiteId_fingerprint_key" ON "TechnicalIssue"("websiteId", "fingerprint");

-- CreateIndex
CREATE INDEX "SearchConsoleDaily_websiteId_date_idx" ON "SearchConsoleDaily"("websiteId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "SearchConsoleDaily_websiteId_date_source_country_device_key" ON "SearchConsoleDaily"("websiteId", "date", "source", "country", "device");

-- CreateIndex
CREATE INDEX "GscQueryMetric_websiteId_date_idx" ON "GscQueryMetric"("websiteId", "date");

-- CreateIndex
CREATE INDEX "GscQueryMetric_websiteId_query_idx" ON "GscQueryMetric"("websiteId", "query");

-- CreateIndex
CREATE INDEX "GscQueryMetric_websiteId_pageId_date_idx" ON "GscQueryMetric"("websiteId", "pageId", "date");

-- CreateIndex
CREATE INDEX "GscQueryMetric_keywordId_date_idx" ON "GscQueryMetric"("keywordId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "GscQueryMetric_websiteId_date_query_page_source_key" ON "GscQueryMetric"("websiteId", "date", "query", "page", "source");

-- CreateIndex
CREATE INDEX "Keyword_websiteId_opportunityScore_idx" ON "Keyword"("websiteId", "opportunityScore");

-- CreateIndex
CREATE INDEX "Keyword_websiteId_clusterId_idx" ON "Keyword"("websiteId", "clusterId");

-- CreateIndex
CREATE INDEX "Keyword_websiteId_isContentGap_idx" ON "Keyword"("websiteId", "isContentGap");

-- CreateIndex
CREATE INDEX "Keyword_websiteId_currentPosition_idx" ON "Keyword"("websiteId", "currentPosition");

-- CreateIndex
CREATE UNIQUE INDEX "Keyword_websiteId_normalized_locale_key" ON "Keyword"("websiteId", "normalized", "locale");

-- CreateIndex
CREATE INDEX "KeywordMetric_keywordId_date_idx" ON "KeywordMetric"("keywordId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "KeywordMetric_keywordId_date_source_key" ON "KeywordMetric"("keywordId", "date", "source");

-- CreateIndex
CREATE INDEX "KeywordCluster_websiteId_opportunityScore_idx" ON "KeywordCluster"("websiteId", "opportunityScore");

-- CreateIndex
CREATE UNIQUE INDEX "KeywordCluster_websiteId_slug_key" ON "KeywordCluster"("websiteId", "slug");

-- CreateIndex
CREATE INDEX "Ranking_websiteId_date_idx" ON "Ranking"("websiteId", "date");

-- CreateIndex
CREATE INDEX "Ranking_keywordId_date_idx" ON "Ranking"("keywordId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Ranking_keywordId_date_source_device_key" ON "Ranking"("keywordId", "date", "source", "device");

-- CreateIndex
CREATE INDEX "Competitor_websiteId_isActive_idx" ON "Competitor"("websiteId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Competitor_websiteId_domain_key" ON "Competitor"("websiteId", "domain");

-- CreateIndex
CREATE INDEX "CompetitorKeyword_competitorId_isGap_idx" ON "CompetitorKeyword"("competitorId", "isGap");

-- CreateIndex
CREATE UNIQUE INDEX "CompetitorKeyword_competitorId_keyword_key" ON "CompetitorKeyword"("competitorId", "keyword");

-- CreateIndex
CREATE UNIQUE INDEX "CompetitorPage_competitorId_url_key" ON "CompetitorPage"("competitorId", "url");

-- CreateIndex
CREATE INDEX "SerpSnapshot_websiteId_query_capturedAt_idx" ON "SerpSnapshot"("websiteId", "query", "capturedAt");

-- CreateIndex
CREATE INDEX "SerpSnapshot_keywordId_capturedAt_idx" ON "SerpSnapshot"("keywordId", "capturedAt");

-- CreateIndex
CREATE INDEX "ContentOpportunity_websiteId_status_priorityScore_idx" ON "ContentOpportunity"("websiteId", "status", "priorityScore");

-- CreateIndex
CREATE INDEX "ContentOpportunity_websiteId_type_idx" ON "ContentOpportunity"("websiteId", "type");

-- CreateIndex
CREATE INDEX "ContentBrief_websiteId_createdAt_idx" ON "ContentBrief"("websiteId", "createdAt");

-- CreateIndex
CREATE INDEX "ContentDraft_websiteId_stage_idx" ON "ContentDraft"("websiteId", "stage");

-- CreateIndex
CREATE INDEX "ContentDraft_websiteId_createdAt_idx" ON "ContentDraft"("websiteId", "createdAt");

-- CreateIndex
CREATE INDEX "ContentStageRun_draftId_stage_idx" ON "ContentStageRun"("draftId", "stage");

-- CreateIndex
CREATE INDEX "ContentVersion_draftId_idx" ON "ContentVersion"("draftId");

-- CreateIndex
CREATE UNIQUE INDEX "ContentVersion_draftId_version_key" ON "ContentVersion"("draftId", "version");

-- CreateIndex
CREATE INDEX "InternalLinkSuggestion_websiteId_status_relevanceScore_idx" ON "InternalLinkSuggestion"("websiteId", "status", "relevanceScore");

-- CreateIndex
CREATE UNIQUE INDEX "InternalLinkSuggestion_sourcePageId_targetPageId_key" ON "InternalLinkSuggestion"("sourcePageId", "targetPageId");

-- CreateIndex
CREATE INDEX "StructuredDataItem_websiteId_schemaType_idx" ON "StructuredDataItem"("websiteId", "schemaType");

-- CreateIndex
CREATE INDEX "StructuredDataItem_pageId_idx" ON "StructuredDataItem"("pageId");

-- CreateIndex
CREATE INDEX "Entity_websiteId_type_idx" ON "Entity"("websiteId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "Entity_websiteId_name_type_key" ON "Entity"("websiteId", "name", "type");

-- CreateIndex
CREATE INDEX "EntityRelationship_toId_idx" ON "EntityRelationship"("toId");

-- CreateIndex
CREATE UNIQUE INDEX "EntityRelationship_fromId_toId_relation_key" ON "EntityRelationship"("fromId", "toId", "relation");

-- CreateIndex
CREATE INDEX "GeoAudit_websiteId_createdAt_idx" ON "GeoAudit"("websiteId", "createdAt");

-- CreateIndex
CREATE INDEX "GeoPageAudit_pageId_idx" ON "GeoPageAudit"("pageId");

-- CreateIndex
CREATE UNIQUE INDEX "GeoPageAudit_auditId_pageId_key" ON "GeoPageAudit"("auditId", "pageId");

-- CreateIndex
CREATE INDEX "AiVisibilityPrompt_websiteId_isActive_priority_idx" ON "AiVisibilityPrompt"("websiteId", "isActive", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "AiVisibilityPrompt_websiteId_prompt_locale_key" ON "AiVisibilityPrompt"("websiteId", "prompt", "locale");

-- CreateIndex
CREATE INDEX "AiVisibilityRun_websiteId_runAt_idx" ON "AiVisibilityRun"("websiteId", "runAt");

-- CreateIndex
CREATE INDEX "AiVisibilityRun_promptId_runAt_idx" ON "AiVisibilityRun"("promptId", "runAt");

-- CreateIndex
CREATE INDEX "AiVisibilityMention_runId_idx" ON "AiVisibilityMention"("runId");

-- CreateIndex
CREATE INDEX "Backlink_websiteId_status_idx" ON "Backlink"("websiteId", "status");

-- CreateIndex
CREATE INDEX "Backlink_websiteId_referringDomain_idx" ON "Backlink"("websiteId", "referringDomain");

-- CreateIndex
CREATE UNIQUE INDEX "Backlink_websiteId_sourceUrl_targetUrl_key" ON "Backlink"("websiteId", "sourceUrl", "targetUrl");

-- CreateIndex
CREATE INDEX "SeoAction_websiteId_status_priorityScore_idx" ON "SeoAction"("websiteId", "status", "priorityScore");

-- CreateIndex
CREATE INDEX "SeoAction_websiteId_type_idx" ON "SeoAction"("websiteId", "type");

-- CreateIndex
CREATE INDEX "ActionExecution_actionId_idx" ON "ActionExecution"("actionId");

-- CreateIndex
CREATE INDEX "Approval_websiteId_status_idx" ON "Approval"("websiteId", "status");

-- CreateIndex
CREATE INDEX "Approval_status_createdAt_idx" ON "Approval"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Experiment_actionId_key" ON "Experiment"("actionId");

-- CreateIndex
CREATE INDEX "Experiment_websiteId_status_idx" ON "Experiment"("websiteId", "status");

-- CreateIndex
CREATE INDEX "ChangeLog_websiteId_createdAt_idx" ON "ChangeLog"("websiteId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentRun_websiteId_agent_startedAt_idx" ON "AgentRun"("websiteId", "agent", "startedAt");

-- CreateIndex
CREATE INDEX "AgentRun_status_idx" ON "AgentRun"("status");

-- CreateIndex
CREATE INDEX "AiUsage_websiteId_createdAt_idx" ON "AiUsage"("websiteId", "createdAt");

-- CreateIndex
CREATE INDEX "AiUsage_createdAt_idx" ON "AiUsage"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "JobRecord_jobId_key" ON "JobRecord"("jobId");

-- CreateIndex
CREATE INDEX "JobRecord_websiteId_createdAt_idx" ON "JobRecord"("websiteId", "createdAt");

-- CreateIndex
CREATE INDEX "JobRecord_status_createdAt_idx" ON "JobRecord"("status", "createdAt");

-- CreateIndex
CREATE INDEX "JobRecord_queue_status_idx" ON "JobRecord"("queue", "status");

-- CreateIndex
CREATE INDEX "ScheduledJob_isEnabled_idx" ON "ScheduledJob"("isEnabled");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledJob_websiteId_name_key" ON "ScheduledJob"("websiteId", "name");

-- CreateIndex
CREATE INDEX "Report_websiteId_type_periodEnd_idx" ON "Report"("websiteId", "type", "periodEnd");

-- CreateIndex
CREATE INDEX "Notification_userId_isRead_createdAt_idx" ON "Notification"("userId", "isRead", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_websiteId_createdAt_idx" ON "Notification"("websiteId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_dedupeKey_key" ON "Notification"("dedupeKey");

-- CreateIndex
CREATE INDEX "ScoreSnapshot_websiteId_date_idx" ON "ScoreSnapshot"("websiteId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ScoreSnapshot_websiteId_date_key" ON "ScoreSnapshot"("websiteId", "date");

-- CreateIndex
CREATE INDEX "StrategyPlan_websiteId_createdAt_idx" ON "StrategyPlan"("websiteId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmbeddingRecord_pageId_key" ON "EmbeddingRecord"("pageId");

-- CreateIndex
CREATE UNIQUE INDEX "EmbeddingRecord_keywordId_key" ON "EmbeddingRecord"("keywordId");

-- CreateIndex
CREATE INDEX "EmbeddingRecord_websiteId_ownerType_idx" ON "EmbeddingRecord"("websiteId", "ownerType");

-- CreateIndex
CREATE UNIQUE INDEX "EmbeddingRecord_ownerType_ownerId_key" ON "EmbeddingRecord"("ownerType", "ownerId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Website" ADD CONSTRAINT "Website_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebsiteSettings" ADD CONSTRAINT "WebsiteSettings_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeBase" ADD CONSTRAINT "KnowledgeBase_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandFact" ADD CONSTRAINT "BrandFact_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Crawl" ADD CONSTRAINT "Crawl_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrawlPage" ADD CONSTRAINT "CrawlPage_crawlId_fkey" FOREIGN KEY ("crawlId") REFERENCES "Crawl"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrawlPage" ADD CONSTRAINT "CrawlPage_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "Page"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LinkEdge" ADD CONSTRAINT "LinkEdge_sourceCrawlPageId_fkey" FOREIGN KEY ("sourceCrawlPageId") REFERENCES "CrawlPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Page" ADD CONSTRAINT "Page_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PageSnapshot" ADD CONSTRAINT "PageSnapshot_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "Page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TechnicalIssue" ADD CONSTRAINT "TechnicalIssue_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TechnicalIssue" ADD CONSTRAINT "TechnicalIssue_crawlId_fkey" FOREIGN KEY ("crawlId") REFERENCES "Crawl"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TechnicalIssue" ADD CONSTRAINT "TechnicalIssue_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "Page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SearchConsoleDaily" ADD CONSTRAINT "SearchConsoleDaily_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GscQueryMetric" ADD CONSTRAINT "GscQueryMetric_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GscQueryMetric" ADD CONSTRAINT "GscQueryMetric_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "Page"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GscQueryMetric" ADD CONSTRAINT "GscQueryMetric_keywordId_fkey" FOREIGN KEY ("keywordId") REFERENCES "Keyword"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Keyword" ADD CONSTRAINT "Keyword_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Keyword" ADD CONSTRAINT "Keyword_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "KeywordCluster"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Keyword" ADD CONSTRAINT "Keyword_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "Page"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KeywordMetric" ADD CONSTRAINT "KeywordMetric_keywordId_fkey" FOREIGN KEY ("keywordId") REFERENCES "Keyword"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KeywordCluster" ADD CONSTRAINT "KeywordCluster_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ranking" ADD CONSTRAINT "Ranking_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ranking" ADD CONSTRAINT "Ranking_keywordId_fkey" FOREIGN KEY ("keywordId") REFERENCES "Keyword"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ranking" ADD CONSTRAINT "Ranking_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "Page"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Competitor" ADD CONSTRAINT "Competitor_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitorKeyword" ADD CONSTRAINT "CompetitorKeyword_competitorId_fkey" FOREIGN KEY ("competitorId") REFERENCES "Competitor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitorKeyword" ADD CONSTRAINT "CompetitorKeyword_keywordId_fkey" FOREIGN KEY ("keywordId") REFERENCES "Keyword"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitorPage" ADD CONSTRAINT "CompetitorPage_competitorId_fkey" FOREIGN KEY ("competitorId") REFERENCES "Competitor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SerpSnapshot" ADD CONSTRAINT "SerpSnapshot_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SerpSnapshot" ADD CONSTRAINT "SerpSnapshot_keywordId_fkey" FOREIGN KEY ("keywordId") REFERENCES "Keyword"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentOpportunity" ADD CONSTRAINT "ContentOpportunity_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentOpportunity" ADD CONSTRAINT "ContentOpportunity_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "Page"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentOpportunity" ADD CONSTRAINT "ContentOpportunity_keywordId_fkey" FOREIGN KEY ("keywordId") REFERENCES "Keyword"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentOpportunity" ADD CONSTRAINT "ContentOpportunity_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "KeywordCluster"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentBrief" ADD CONSTRAINT "ContentBrief_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentBrief" ADD CONSTRAINT "ContentBrief_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "ContentOpportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentDraft" ADD CONSTRAINT "ContentDraft_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentDraft" ADD CONSTRAINT "ContentDraft_briefId_fkey" FOREIGN KEY ("briefId") REFERENCES "ContentBrief"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentDraft" ADD CONSTRAINT "ContentDraft_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "Page"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentStageRun" ADD CONSTRAINT "ContentStageRun_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "ContentDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentVersion" ADD CONSTRAINT "ContentVersion_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "ContentDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InternalLinkSuggestion" ADD CONSTRAINT "InternalLinkSuggestion_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InternalLinkSuggestion" ADD CONSTRAINT "InternalLinkSuggestion_sourcePageId_fkey" FOREIGN KEY ("sourcePageId") REFERENCES "Page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InternalLinkSuggestion" ADD CONSTRAINT "InternalLinkSuggestion_targetPageId_fkey" FOREIGN KEY ("targetPageId") REFERENCES "Page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StructuredDataItem" ADD CONSTRAINT "StructuredDataItem_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StructuredDataItem" ADD CONSTRAINT "StructuredDataItem_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "Page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Entity" ADD CONSTRAINT "Entity_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntityRelationship" ADD CONSTRAINT "EntityRelationship_fromId_fkey" FOREIGN KEY ("fromId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntityRelationship" ADD CONSTRAINT "EntityRelationship_toId_fkey" FOREIGN KEY ("toId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeoAudit" ADD CONSTRAINT "GeoAudit_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeoPageAudit" ADD CONSTRAINT "GeoPageAudit_auditId_fkey" FOREIGN KEY ("auditId") REFERENCES "GeoAudit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeoPageAudit" ADD CONSTRAINT "GeoPageAudit_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "Page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiVisibilityPrompt" ADD CONSTRAINT "AiVisibilityPrompt_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiVisibilityRun" ADD CONSTRAINT "AiVisibilityRun_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiVisibilityRun" ADD CONSTRAINT "AiVisibilityRun_promptId_fkey" FOREIGN KEY ("promptId") REFERENCES "AiVisibilityPrompt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiVisibilityMention" ADD CONSTRAINT "AiVisibilityMention_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AiVisibilityRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Backlink" ADD CONSTRAINT "Backlink_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeoAction" ADD CONSTRAINT "SeoAction_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionExecution" ADD CONSTRAINT "ActionExecution_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "SeoAction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "SeoAction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Experiment" ADD CONSTRAINT "Experiment_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Experiment" ADD CONSTRAINT "Experiment_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "SeoAction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Experiment" ADD CONSTRAINT "Experiment_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "Page"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeLog" ADD CONSTRAINT "ChangeLog_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeLog" ADD CONSTRAINT "ChangeLog_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "SeoAction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeLog" ADD CONSTRAINT "ChangeLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiUsage" ADD CONSTRAINT "AiUsage_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRecord" ADD CONSTRAINT "JobRecord_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledJob" ADD CONSTRAINT "ScheduledJob_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScoreSnapshot" ADD CONSTRAINT "ScoreSnapshot_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StrategyPlan" ADD CONSTRAINT "StrategyPlan_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmbeddingRecord" ADD CONSTRAINT "EmbeddingRecord_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "Page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmbeddingRecord" ADD CONSTRAINT "EmbeddingRecord_keywordId_fkey" FOREIGN KEY ("keywordId") REFERENCES "Keyword"("id") ON DELETE CASCADE ON UPDATE CASCADE;
