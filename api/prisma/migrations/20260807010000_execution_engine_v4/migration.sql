-- Execution Engine V4 executes qualified signals immediately and monitors up
-- to five positions. Existing accounts are moved off the legacy Target-1 wait.
UPDATE "RealTradingAccount"
SET "maxOpenTrades" = 5,
    "minimumConfidence" = 75,
    "entryMode" = 'IMMEDIATE_ENTRY'
WHERE "maxOpenTrades" = 1
  AND "entryMode" = 'TARGET1_CONFIRMATION';

ALTER TABLE "RealTradeOrder" ADD COLUMN "highestPrice" REAL;
ALTER TABLE "RealTradeOrder" ADD COLUMN "lowestPrice" REAL;
ALTER TABLE "RealTradeOrder" ADD COLUMN "maxDrawdown" REAL NOT NULL DEFAULT 0;
ALTER TABLE "RealTradeOrder" ADD COLUMN "target1ExitTime" DATETIME;
ALTER TABLE "RealTradeOrder" ADD COLUMN "target1ExitPrice" REAL;
