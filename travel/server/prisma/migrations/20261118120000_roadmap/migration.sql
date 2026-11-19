-- AlterTable
ALTER TABLE "Destination" ADD COLUMN "planYear" INTEGER,
ADD COLUMN "planSeason" TEXT,
ADD COLUMN "tier" TEXT,
ADD COLUMN "isFar" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "days" INTEGER,
ADD COLUMN "dailyCost" DOUBLE PRECISION,
ADD COLUMN "transitCost" DOUBLE PRECISION,
ADD COLUMN "mobility" TEXT,
ADD COLUMN "pairingId" TEXT;

-- CreateTable
CREATE TABLE "Pairing" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "year" INTEGER,
    "quarter" TEXT,
    "savings" DOUBLE PRECISION NOT NULL DEFAULT 0,
    CONSTRAINT "Pairing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoadmapSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "startYear" INTEGER NOT NULL DEFAULT 2027,
    "endYear" INTEGER NOT NULL DEFAULT 2034,
    "annualCap" DOUBLE PRECISION NOT NULL DEFAULT 30000,
    "maxFarPerYear" INTEGER NOT NULL DEFAULT 2,
    "ageA" INTEGER,
    "ageB" INTEGER,
    "highMobilityUntil" INTEGER,
    CONSTRAINT "RoadmapSettings_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Destination" ADD CONSTRAINT "Destination_pairingId_fkey" FOREIGN KEY ("pairingId") REFERENCES "Pairing"("id") ON DELETE SET NULL ON UPDATE CASCADE;
