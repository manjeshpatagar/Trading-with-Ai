ALTER TABLE "PaperTradingAccount" ADD COLUMN "entryMode" TEXT NOT NULL DEFAULT 'TARGET1_CONFIRMATION';
ALTER TABLE "PaperTradingAccount" ADD COLUMN "minimumDailyTrades" INTEGER NOT NULL DEFAULT 2;
ALTER TABLE "PaperTradingAccount" ADD COLUMN "preferredDailyTrades" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE "PaperTradingAccount" ADD COLUMN "maximumDailyTrades" INTEGER NOT NULL DEFAULT 10;
ALTER TABLE "PaperTradingAccount" ADD COLUMN "maximumDailyLoss" REAL NOT NULL DEFAULT 1000;
ALTER TABLE "PaperTradingAccount" ADD COLUMN "maximumDailyProfit" REAL NOT NULL DEFAULT 2000;
ALTER TABLE "PaperTradingAccount" ADD COLUMN "squareOffTime" TEXT NOT NULL DEFAULT '14:45';

ALTER TABLE "PaperOrder" ADD COLUMN "remainingQuantity" REAL;
ALTER TABLE "PaperOrder" ADD COLUMN "rankScore" REAL NOT NULL DEFAULT 0;
ALTER TABLE "PaperOrder" ADD COLUMN "entryQuality" TEXT NOT NULL DEFAULT 'Good';
ALTER TABLE "PaperOrder" ADD COLUMN "partialExitQuantity" REAL NOT NULL DEFAULT 0;
ALTER TABLE "PaperOrder" ADD COLUMN "partialExitPrice" REAL;
ALTER TABLE "PaperOrder" ADD COLUMN "partialExitAt" DATETIME;
ALTER TABLE "PaperOrder" ADD COLUMN "partialRealizedPnl" REAL NOT NULL DEFAULT 0;

CREATE TABLE "DemoStrategyOptimizer" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "tradingDate" TEXT NOT NULL,
  "bestStrategy" TEXT,
  "bestSector" TEXT,
  "bestTime" TEXT,
  "bestConfidence" REAL,
  "bestAiScore" REAL,
  "bestRiskReward" REAL,
  "worstStrategy" TEXT,
  "worstSector" TEXT,
  "worstTime" TEXT,
  "worstConfidence" REAL,
  "sampleSize" INTEGER NOT NULL DEFAULT 0,
  "summary" TEXT NOT NULL DEFAULT '{}',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "DemoStrategyOptimizer_userId_tradingDate_key" ON "DemoStrategyOptimizer"("userId", "tradingDate");
CREATE INDEX "DemoStrategyOptimizer_userId_tradingDate_idx" ON "DemoStrategyOptimizer"("userId", "tradingDate");
