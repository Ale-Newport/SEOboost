-- CreateEnum
CREATE TYPE "MailProvider" AS ENUM ('IMAP_SMTP', 'GMAIL_OAUTH');

-- CreateEnum
CREATE TYPE "PersonalAccountProvider" AS ENUM ('GITHUB', 'REDDIT');

-- CreateTable
CREATE TABLE "MailAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT,
    "provider" "MailProvider" NOT NULL DEFAULT 'IMAP_SMTP',
    "status" "IntegrationStatus" NOT NULL DEFAULT 'NOT_CONFIGURED',
    "credentials" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonalAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "PersonalAccountProvider" NOT NULL,
    "handle" TEXT,
    "email" TEXT,
    "displayName" TEXT,
    "status" "IntegrationStatus" NOT NULL DEFAULT 'NOT_CONFIGURED',
    "credentials" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "lastUsedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PersonalAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MailAccount_userId_email_key" ON "MailAccount"("userId", "email");

-- CreateIndex
CREATE INDEX "PersonalAccount_userId_provider_idx" ON "PersonalAccount"("userId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "PersonalAccount_userId_provider_handle_key" ON "PersonalAccount"("userId", "provider", "handle");

-- AddForeignKey
ALTER TABLE "MailAccount" ADD CONSTRAINT "MailAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonalAccount" ADD CONSTRAINT "PersonalAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
