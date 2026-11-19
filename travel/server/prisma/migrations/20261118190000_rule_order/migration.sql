-- AlterTable
ALTER TABLE "RoadmapSettings" ADD COLUMN "ruleOrder" TEXT[] DEFAULT ARRAY[]::TEXT[];
