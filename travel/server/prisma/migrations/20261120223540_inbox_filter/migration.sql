-- AlterTable
ALTER TABLE "InboxItem" ADD COLUMN "filterReason" TEXT;

-- CreateTable
CREATE TABLE "InboxBlockedSender" (
    "id" TEXT NOT NULL,
    "addr" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboxBlockedSender_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InboxBlockedSender_addr_key" ON "InboxBlockedSender"("addr");
