ALTER TABLE "AiSignal" ADD COLUMN "signalGeneratedAt" DATETIME;
ALTER TABLE "AiSignal" ADD COLUMN "entryExecutedPrice" REAL;
ALTER TABLE "AiSignal" ADD COLUMN "target1HitAt" DATETIME;
ALTER TABLE "AiSignal" ADD COLUMN "target1ExecutedPrice" REAL;
ALTER TABLE "AiSignal" ADD COLUMN "target2HitAt" DATETIME;
ALTER TABLE "AiSignal" ADD COLUMN "target2ExecutedPrice" REAL;
ALTER TABLE "AiSignal" ADD COLUMN "target3HitAt" DATETIME;
ALTER TABLE "AiSignal" ADD COLUMN "target3ExecutedPrice" REAL;
ALTER TABLE "AiSignal" ADD COLUMN "stopLossHitAt" DATETIME;
ALTER TABLE "AiSignal" ADD COLUMN "exitPrice" REAL;
ALTER TABLE "AiSignal" ADD COLUMN "lossPercent" REAL;

UPDATE "AiSignal" SET
  "signalGeneratedAt" = "signalTime",
  "entryExecutedPrice" = CASE WHEN "entryTriggeredAt" IS NOT NULL THEN "entryPrice" END,
  "target1HitAt" = "target1At",
  "target1ExecutedPrice" = CASE WHEN "target1At" IS NOT NULL THEN "target1" END,
  "target2HitAt" = "target2At",
  "target2ExecutedPrice" = CASE WHEN "target2At" IS NOT NULL THEN "target2" END,
  "target3HitAt" = "target3At",
  "target3ExecutedPrice" = CASE WHEN "target3At" IS NOT NULL THEN "target3" END,
  "stopLossHitAt" = "stopLossAt",
  "exitPrice" = CASE WHEN "completedAt" IS NULL THEN NULL WHEN "status"='STOPLOSS_HIT' THEN "stopLoss" ELSE "target3" END,
  "lossPercent" = CASE WHEN COALESCE("profitPercent",0) < 0 THEN ABS("profitPercent") ELSE 0 END;
