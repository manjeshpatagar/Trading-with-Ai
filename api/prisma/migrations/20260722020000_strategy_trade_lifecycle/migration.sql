DROP INDEX IF EXISTS "AiSignal_one_active_trade_idx";

-- If legacy data contains duplicates for the expanded key, retain every row but
-- close older active records before installing the invariant.
UPDATE "AiSignal"
SET "status" = 'COMPLETED', "completedAt" = COALESCE("completedAt", "updatedAt")
WHERE "id" IN (
  SELECT older."id"
  FROM "AiSignal" older
  JOIN "AiSignal" newer
    ON newer."userId" = older."userId"
   AND newer."instrumentKey" = older."instrumentKey"
   AND newer."timeframe" = older."timeframe"
   AND newer."strategy" = older."strategy"
   AND (newer."signalTime" > older."signalTime" OR (newer."signalTime" = older."signalTime" AND newer."id" > older."id"))
  WHERE older."status" IN ('WAITING','ENTRY_TRIGGERED','RUNNING','TARGET1_HIT','TARGET2_HIT','TARGET3_HIT')
    AND newer."status" IN ('WAITING','ENTRY_TRIGGERED','RUNNING','TARGET1_HIT','TARGET2_HIT','TARGET3_HIT')
);

CREATE UNIQUE INDEX "AiSignal_one_active_strategy_trade_idx"
ON "AiSignal"("userId", "instrumentKey", "timeframe", "strategy")
WHERE "status" IN ('WAITING','ENTRY_TRIGGERED','RUNNING','TARGET1_HIT','TARGET2_HIT','TARGET3_HIT');
