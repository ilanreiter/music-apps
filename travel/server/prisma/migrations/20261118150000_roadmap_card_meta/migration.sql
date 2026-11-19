-- AlterTable
ALTER TABLE "Destination" ADD COLUMN "secondSeason" TEXT,
ADD COLUMN "weather" TEXT,
ADD COLUMN "weatherAlt" TEXT,
ADD COLUMN "lat" DOUBLE PRECISION,
ADD COLUMN "lng" DOUBLE PRECISION,
ADD COLUMN "suggestedYear" INTEGER,
ADD COLUMN "suggestedSeason" TEXT;
