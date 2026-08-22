-- CreateTable
CREATE TABLE "Traveler" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "age" INTEGER,
    "travelPreferences" TEXT,
    "stayPreferences" TEXT,
    "transportPreferences" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Traveler_pkey" PRIMARY KEY ("id")
);
