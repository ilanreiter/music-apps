-- CreateEnum
CREATE TYPE "TripPlanningType" AS ENUM ('SELF_PLANNED', 'GROUP', 'ORGANIZED');

-- CreateEnum
CREATE TYPE "TripGoal" AS ENUM ('NATURE', 'SIGHTSEEING', 'CITY', 'RELAXATION', 'ADVENTURE', 'MIXED', 'OTHER');

-- AlterTable
ALTER TABLE "Trip" ADD COLUMN     "durationNights" INTEGER,
ADD COLUMN     "goal" "TripGoal",
ADD COLUMN     "planningType" "TripPlanningType",
ADD COLUMN     "travelSeason" TEXT;

-- CreateTable
CREATE TABLE "Preferences" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "interests" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pace" TEXT,
    "budgetStyle" TEXT,
    "notes" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Preferences_pkey" PRIMARY KEY ("id")
);
