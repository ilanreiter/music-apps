-- AlterTable
ALTER TABLE "InboxItem" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'email';
ALTER TABLE "InboxItem" ADD COLUMN "newTripHint" JSONB;
