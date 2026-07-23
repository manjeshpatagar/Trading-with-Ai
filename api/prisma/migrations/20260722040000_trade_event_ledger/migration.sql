CREATE TABLE "AiTradeEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tradeId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "triggerPrice" REAL NOT NULL,
  "executedPrice" REAL NOT NULL,
  "eventTime" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "profitPercent" REAL NOT NULL,
  "holdingMinutes" INTEGER NOT NULL,
  CONSTRAINT "AiTradeEvent_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "AiSignal" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "AiTradeEvent_tradeId_type_key" ON "AiTradeEvent"("tradeId", "type");
CREATE INDEX "AiTradeEvent_tradeId_eventTime_idx" ON "AiTradeEvent"("tradeId", "eventTime");

INSERT INTO "AiTradeEvent" ("id", "tradeId", "type", "triggerPrice", "executedPrice", "eventTime", "profitPercent", "holdingMinutes")
SELECT lower(hex(randomblob(16))), "id", 'SIGNAL_GENERATED', "currentPrice", "currentPrice", "signalTime", 0, 0 FROM "AiSignal";

INSERT INTO "AiTradeEvent" SELECT lower(hex(randomblob(16))), "id", 'ENTRY_TRIGGERED', "entryPrice", "entryPrice", "entryTriggeredAt", 0, 0 FROM "AiSignal" WHERE "entryTriggeredAt" IS NOT NULL;
INSERT INTO "AiTradeEvent" SELECT lower(hex(randomblob(16))), "id", 'TARGET1_HIT', "target1", "target1", "target1At", CASE WHEN "side"='BUY' THEN ("target1"-"entryPrice")/"entryPrice"*100 ELSE ("entryPrice"-"target1")/"entryPrice"*100 END, 0 FROM "AiSignal" WHERE "target1At" IS NOT NULL;
INSERT INTO "AiTradeEvent" SELECT lower(hex(randomblob(16))), "id", 'TARGET2_HIT', "target2", "target2", "target2At", CASE WHEN "side"='BUY' THEN ("target2"-"entryPrice")/"entryPrice"*100 ELSE ("entryPrice"-"target2")/"entryPrice"*100 END, 0 FROM "AiSignal" WHERE "target2At" IS NOT NULL;
INSERT INTO "AiTradeEvent" SELECT lower(hex(randomblob(16))), "id", 'TARGET3_HIT', "target3", "target3", "target3At", CASE WHEN "side"='BUY' THEN ("target3"-"entryPrice")/"entryPrice"*100 ELSE ("entryPrice"-"target3")/"entryPrice"*100 END, COALESCE("holdingMinutes",0) FROM "AiSignal" WHERE "target3At" IS NOT NULL;
INSERT INTO "AiTradeEvent" SELECT lower(hex(randomblob(16))), "id", 'STOPLOSS_HIT', "stopLoss", "stopLoss", "stopLossAt", COALESCE("profitPercent",0), COALESCE("holdingMinutes",0) FROM "AiSignal" WHERE "stopLossAt" IS NOT NULL;
INSERT INTO "AiTradeEvent" SELECT lower(hex(randomblob(16))), "id", 'COMPLETED', CASE WHEN "status"='STOPLOSS_HIT' THEN "stopLoss" ELSE "target3" END, CASE WHEN "status"='STOPLOSS_HIT' THEN "stopLoss" ELSE "target3" END, "completedAt", COALESCE("profitPercent",0), COALESCE("holdingMinutes",0) FROM "AiSignal" WHERE "completedAt" IS NOT NULL;
