ALTER TABLE "AiSignal" ADD COLUMN "executionEligible" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AiSignal" ADD COLUMN "executionStatus" TEXT NOT NULL DEFAULT 'NOT_EXECUTED';
ALTER TABLE "AiSignal" ADD COLUMN "demoExecuted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AiSignal" ADD COLUMN "demoTradeId" TEXT;
ALTER TABLE "AiSignal" ADD COLUMN "executionSnapshot" TEXT;
ALTER TABLE "AiSignal" ADD COLUMN "executedPrice" REAL;
ALTER TABLE "AiSignal" ADD COLUMN "executedAt" DATETIME;
ALTER TABLE "AiSignal" ADD COLUMN "signalExpiredAt" DATETIME;

CREATE INDEX "AiSignal_userId_status_executionEligible_demoExecuted_idx"
ON "AiSignal"("userId", "status", "executionEligible", "demoExecuted");
