-- AlterTable
ALTER TABLE "RoadmapSettings" ADD COLUMN "ruleDisabled" TEXT[] DEFAULT ARRAY[]::TEXT[];
