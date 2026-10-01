-- Additive only: preserve all accounts, signals, trades and historical fills.
ALTER TABLE "PaperTradingAccount" ADD COLUMN "maxDailyLossPercent" REAL NOT NULL DEFAULT 3;
ALTER TABLE "PaperTradingAccount" ADD COLUMN "maxCombinedLossPercent" REAL NOT NULL DEFAULT 4;
ALTER TABLE "PaperTradingAccount" ADD COLUMN "maxConsecutiveLosses" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "PaperTradingAccount" ADD COLUMN "maxEntriesPerSymbol" INTEGER NOT NULL DEFAULT 2;
ALTER TABLE "PaperTradingAccount" ADD COLUMN "stopCooldownMinutes" INTEGER NOT NULL DEFAULT 15;
ALTER TABLE "PaperTradingAccount" ADD COLUMN "configurationVersion" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "PaperOrder" ADD COLUMN "initialStopLoss" REAL;
ALTER TABLE "PaperOrder" ADD COLUMN "riskAmount" REAL;
ALTER TABLE "PaperOrder" ADD COLUMN "configurationSnapshot" TEXT;
ALTER TABLE "PaperOrder" ADD COLUMN "entryMode" TEXT;
ALTER TABLE "AiSignal" ADD COLUMN "strategyAssessment" TEXT;
ALTER TABLE "PaperTradingAccount" ADD COLUMN "entryMode" TEXT NOT NULL DEFAULT 'TARGET1';
ALTER TABLE "DemoTradeQueue" ADD COLUMN "entryMode" TEXT NOT NULL DEFAULT 'TARGET1';
ALTER TABLE "RealTradingControl" ADD COLUMN "riskPerTrade" REAL NOT NULL DEFAULT 0.5;
ALTER TABLE "RealTradingControl" ADD COLUMN "maximumRiskAmount" REAL NOT NULL DEFAULT 100;
ALTER TABLE "PaperTradingAccount" ADD COLUMN "slippageBps" REAL NOT NULL DEFAULT 2;
ALTER TABLE "PaperTradingAccount" ADD COLUMN "spreadBps" REAL NOT NULL DEFAULT 2;
