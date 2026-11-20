-- CreateTable
CREATE TABLE "TripImport" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "summary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TripImport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TripImport_tripId_hash_key" ON "TripImport"("tripId", "hash");

-- AddForeignKey
ALTER TABLE "TripImport" ADD CONSTRAINT "TripImport_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;
