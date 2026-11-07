-- CreateEnum
CREATE TYPE "SocialPlatform" AS ENUM ('REDDIT', 'HACKER_NEWS', 'X', 'BLUESKY', 'MASTODON', 'LINKEDIN', 'DEVTO', 'TELEGRAM', 'DISCORD', 'YOUTUBE', 'GITHUB', 'FACEBOOK', 'INSTAGRAM', 'V2EX');

-- CreateEnum
CREATE TYPE "SocialConversationStatus" AS ENUM ('NEW', 'SHORTLISTED', 'DRAFTED', 'REPLIED', 'DISMISSED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "SocialPostKind" AS ENUM ('REPLY', 'ORIGINAL');

-- CreateEnum
CREATE TYPE "SocialPostStatus" AS ENUM ('DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'MANUAL_PENDING', 'FAILED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CommunityPromotionPolicy" AS ENUM ('ALLOWED', 'RESTRICTED', 'FORBIDDEN', 'UNKNOWN');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ActionType" ADD VALUE 'SOCIAL_REPLY';
ALTER TYPE "ActionType" ADD VALUE 'SOCIAL_POST';

-- AlterTable
ALTER TABLE "WebsiteSettings" ADD COLUMN     "socialDailyPostLimit" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "socialDailyReplyLimit" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "socialDisclosure" TEXT,
ADD COLUMN     "socialMaxPromoRatio" DOUBLE PRECISION NOT NULL DEFAULT 0.25,
ADD COLUMN     "socialUtmCampaign" TEXT NOT NULL DEFAULT 'social';

-- CreateTable
CREATE TABLE "SocialAccount" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "status" "IntegrationStatus" NOT NULL DEFAULT 'NOT_CONFIGURED',
    "handle" TEXT,
    "displayName" TEXT,
    "credentials" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "lastPostAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastTestedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialTopic" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "negativeKeywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "platforms" "SocialPlatform"[] DEFAULT ARRAY['REDDIT', 'HACKER_NEWS']::"SocialPlatform"[],
    "communities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "kind" TEXT NOT NULL DEFAULT 'problem',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "lastRunAt" TIMESTAMP(3),
    "lastResultCount" INTEGER,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialTopic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialConversation" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "topicId" TEXT,
    "platform" "SocialPlatform" NOT NULL,
    "externalId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT,
    "body" TEXT,
    "author" TEXT,
    "community" TEXT,
    "publishedAt" TIMESTAMP(3),
    "score" INTEGER,
    "commentCount" INTEGER,
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "intent" TEXT NOT NULL DEFAULT 'discussion',
    "relevanceScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "relevanceFactors" JSONB NOT NULL DEFAULT '{}',
    "triage" JSONB,
    "status" "SocialConversationStatus" NOT NULL DEFAULT 'NEW',
    "backend" TEXT NOT NULL,
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastCheckedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialCommunity" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT,
    "subscribers" INTEGER,
    "promotionPolicy" "CommunityPromotionPolicy" NOT NULL DEFAULT 'UNKNOWN',
    "rulesSummary" TEXT,
    "rules" JSONB NOT NULL DEFAULT '[]',
    "isBlocked" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialCommunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialPost" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "accountId" TEXT,
    "conversationId" TEXT,
    "actionId" TEXT,
    "pageId" TEXT,
    "kind" "SocialPostKind" NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "status" "SocialPostStatus" NOT NULL DEFAULT 'DRAFT',
    "community" TEXT,
    "title" TEXT,
    "body" TEXT NOT NULL,
    "linkUrl" TEXT,
    "includesLink" BOOLEAN NOT NULL DEFAULT false,
    "disclosure" TEXT,
    "generatedBy" TEXT,
    "scheduledFor" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "externalId" TEXT,
    "externalUrl" TEXT,
    "metrics" JSONB NOT NULL DEFAULT '{}',
    "metricsCheckedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialPost_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SocialAccount_websiteId_platform_key" ON "SocialAccount"("websiteId", "platform");

-- CreateIndex
CREATE INDEX "SocialTopic_websiteId_isActive_idx" ON "SocialTopic"("websiteId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "SocialTopic_websiteId_query_key" ON "SocialTopic"("websiteId", "query");

-- CreateIndex
CREATE INDEX "SocialConversation_websiteId_status_relevanceScore_idx" ON "SocialConversation"("websiteId", "status", "relevanceScore");

-- CreateIndex
CREATE INDEX "SocialConversation_websiteId_discoveredAt_idx" ON "SocialConversation"("websiteId", "discoveredAt");

-- CreateIndex
CREATE UNIQUE INDEX "SocialConversation_websiteId_platform_externalId_key" ON "SocialConversation"("websiteId", "platform", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "SocialCommunity_websiteId_platform_name_key" ON "SocialCommunity"("websiteId", "platform", "name");

-- CreateIndex
CREATE UNIQUE INDEX "SocialPost_actionId_key" ON "SocialPost"("actionId");

-- CreateIndex
CREATE INDEX "SocialPost_websiteId_status_scheduledFor_idx" ON "SocialPost"("websiteId", "status", "scheduledFor");

-- CreateIndex
CREATE INDEX "SocialPost_websiteId_platform_publishedAt_idx" ON "SocialPost"("websiteId", "platform", "publishedAt");

-- AddForeignKey
ALTER TABLE "SocialAccount" ADD CONSTRAINT "SocialAccount_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialTopic" ADD CONSTRAINT "SocialTopic_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialConversation" ADD CONSTRAINT "SocialConversation_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialConversation" ADD CONSTRAINT "SocialConversation_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "SocialTopic"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialCommunity" ADD CONSTRAINT "SocialCommunity_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialPost" ADD CONSTRAINT "SocialPost_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialPost" ADD CONSTRAINT "SocialPost_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "SocialAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialPost" ADD CONSTRAINT "SocialPost_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "SocialConversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialPost" ADD CONSTRAINT "SocialPost_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "SeoAction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
