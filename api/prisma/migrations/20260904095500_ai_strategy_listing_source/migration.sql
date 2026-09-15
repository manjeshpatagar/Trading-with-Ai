ALTER TABLE "AiSignal" ADD COLUMN "aiStrategyListed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AiSignal" ADD COLUMN "aiStrategyRank" INTEGER;
ALTER TABLE "AiSignal" ADD COLUMN "aiStrategyListedAt" DATETIME;
CREATE INDEX "AiSignal_userId_aiStrategyListed_signalTime_idx" ON "AiSignal"("userId", "aiStrategyListed", "signalTime");
