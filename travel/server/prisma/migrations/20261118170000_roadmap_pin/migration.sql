-- AlterTable
ALTER TABLE "Destination" ADD COLUMN "suggestedPriority" INTEGER,
ADD COLUMN "pinned" BOOLEAN NOT NULL DEFAULT false;
