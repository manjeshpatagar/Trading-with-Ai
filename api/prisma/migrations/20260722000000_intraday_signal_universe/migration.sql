ALTER TABLE "AiSignal" ADD COLUMN "sector" TEXT NOT NULL DEFAULT 'NSE Equity';
ALTER TABLE "AiSignal" ADD COLUMN "volume" REAL NOT NULL DEFAULT 0;
ALTER TABLE "AiSignal" ADD COLUMN "universeRank" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AiSignal" ADD COLUMN "selectionScore" REAL NOT NULL DEFAULT 0;
ALTER TABLE "AiSignal" ADD COLUMN "top100Selected" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "AiSignal_userId_top100Selected_signalTime_idx" ON "AiSignal"("userId", "top100Selected", "signalTime");

ALTER TABLE "NseInstrument" ADD COLUMN "sector" TEXT NOT NULL DEFAULT 'NSE Equity';
