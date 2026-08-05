PRAGMA foreign_keys=OFF;

UPDATE "RealTradingAccount" SET "entryMode" = CASE
  WHEN "entryMode" = 'ENTRY_TRIGGER' THEN 'IMMEDIATE_ENTRY'
  WHEN "entryMode" = 'PULLBACK_AFTER_ENTRY' THEN 'RUNNING_CONFIRMATION'
  WHEN "entryMode" = 'TARGET1_BREAKOUT' THEN 'TARGET1_CONFIRMATION'
  WHEN "entryMode" = 'TARGET1_PULLBACK' THEN 'TARGET2_PULLBACK'
  ELSE "entryMode"
END;

ALTER TABLE "RealTradeOrder" ADD COLUMN "remainingQuantity" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "RealTradeOrder" ADD COLUMN "target2ExitTime" DATETIME;
ALTER TABLE "RealTradeOrder" ADD COLUMN "target2ExitPrice" REAL;
ALTER TABLE "RealTradeOrder" ADD COLUMN "realizedPnl" REAL NOT NULL DEFAULT 0;
UPDATE "RealTradeOrder" SET "remainingQuantity" = "quantity";

ALTER TABLE "RealTradeQueue" ADD COLUMN "runningTime" DATETIME;
ALTER TABLE "RealTradeQueue" ADD COLUMN "target1Reached" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "RealTradeQueue" ADD COLUMN "target1Time" DATETIME;
ALTER TABLE "RealTradeQueue" ADD COLUMN "target1Price" REAL;
ALTER TABLE "RealTradeQueue" ADD COLUMN "target1Momentum" REAL;
ALTER TABLE "RealTradeQueue" ADD COLUMN "target1Volume" REAL;
ALTER TABLE "RealTradeQueue" ADD COLUMN "target1VolumeIncreasing" BOOLEAN;
ALTER TABLE "RealTradeQueue" ADD COLUMN "target1Vwap" REAL;
ALTER TABLE "RealTradeQueue" ADD COLUMN "target1Ema20" REAL;
ALTER TABLE "RealTradeQueue" ADD COLUMN "target1Ema50" REAL;
ALTER TABLE "RealTradeQueue" ADD COLUMN "target1Rsi" REAL;
ALTER TABLE "RealTradeQueue" ADD COLUMN "target1Macd" REAL;
ALTER TABLE "RealTradeQueue" ADD COLUMN "target1Atr" REAL;

PRAGMA foreign_keys=ON;
