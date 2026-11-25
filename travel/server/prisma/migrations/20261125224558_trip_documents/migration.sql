-- AlterTable
ALTER TABLE "Preferences" ADD COLUMN "docsFolder" TEXT;
ALTER TABLE "Preferences" ADD COLUMN "docsNaming" TEXT NOT NULL DEFAULT 'month';

-- CreateTable
CREATE TABLE "TripDocument" (
    "id" TEXT NOT NULL,
    "tripId" TEXT,
    "inboxItemId" TEXT,
    "name" TEXT NOT NULL,
    "relPath" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "mime" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TripDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TripDocument_tripId_idx" ON "TripDocument"("tripId");
CREATE INDEX "TripDocument_inboxItemId_idx" ON "TripDocument"("inboxItemId");

-- AddForeignKey
ALTER TABLE "TripDocument" ADD CONSTRAINT "TripDocument_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE SET NULL ON UPDATE CASCADE;
