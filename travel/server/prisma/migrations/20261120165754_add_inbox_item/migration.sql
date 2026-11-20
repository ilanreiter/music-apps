-- CreateTable
CREATE TABLE "InboxItem" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "fromAddr" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "bodyText" TEXT NOT NULL,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "suggestedTripId" TEXT,
    "suggestionNote" TEXT,
    "tripId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboxItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InboxItem_messageId_key" ON "InboxItem"("messageId");
