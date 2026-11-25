ALTER TABLE "TripItem" ADD COLUMN "sourceInboxId" TEXT;
ALTER TABLE "ChecklistItem" ADD COLUMN "sourceInboxId" TEXT;
ALTER TABLE "InsurancePolicy" ADD COLUMN "sourceInboxId" TEXT;
ALTER TABLE "Resource" ADD COLUMN "sourceInboxId" TEXT;
ALTER TABLE "TripDocument" ADD COLUMN "role" TEXT NOT NULL DEFAULT 'attachment';
ALTER TABLE "TripDocument" ADD COLUMN "sourceUrl" TEXT;
