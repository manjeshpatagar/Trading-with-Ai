-- Preserve existing history while making already-triggered, never-executed BUY/SELL
-- records visible to the canonical demo consumer.
UPDATE "AiSignal"
SET "executionEligible" = true,
    "executionStatus" = 'ELIGIBLE'
WHERE "status" = 'ENTRY_TRIGGERED'
  AND "side" IN ('BUY', 'SELL')
  AND "entryTriggeredAt" IS NOT NULL
  AND "entryPrice" > 0
  AND "stopLoss" > 0
  AND "target1" > 0
  AND "demoExecuted" = false;

-- Reconcile historical demo orders without creating or deleting any records.
UPDATE "AiSignal"
SET "demoExecuted" = true,
    "executionEligible" = true,
    "executionStatus" = CASE WHEN "completedAt" IS NULL THEN 'DEMO_EXECUTED' ELSE 'COMPLETED' END,
    "demoTradeId" = (SELECT "id" FROM "PaperOrder" WHERE "PaperOrder"."signalId" = "AiSignal"."id"),
    "executedPrice" = (SELECT "entryPrice" FROM "PaperOrder" WHERE "PaperOrder"."signalId" = "AiSignal"."id"),
    "executedAt" = (SELECT "entryTime" FROM "PaperOrder" WHERE "PaperOrder"."signalId" = "AiSignal"."id")
WHERE EXISTS (SELECT 1 FROM "PaperOrder" WHERE "PaperOrder"."signalId" = "AiSignal"."id");
