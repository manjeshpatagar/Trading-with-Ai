ALTER TABLE "AiSignal" ADD COLUMN "setupFingerprint" TEXT NOT NULL DEFAULT '';

UPDATE "AiSignal" SET "status" = 'TARGET1_HIT' WHERE "status" = 'TARGET_1_HIT';
UPDATE "AiSignal" SET "status" = 'TARGET2_HIT' WHERE "status" = 'TARGET_2_HIT';
UPDATE "AiSignal" SET "status" = 'TARGET3_HIT' WHERE "status" = 'TARGET_3_HIT';
UPDATE "AiSignal" SET "status" = 'STOPLOSS_HIT' WHERE "status" = 'STOP_LOSS_HIT';

-- Preserve duplicate history, but close older active duplicates before enforcing
-- the invariant that only the newest trade can remain active.
UPDATE "AiSignal"
SET "status" = 'COMPLETED', "completedAt" = COALESCE("completedAt", "updatedAt")
WHERE "id" IN (
  SELECT older."id"
  FROM "AiSignal" older
  JOIN "AiSignal" newer
    ON newer."userId" = older."userId"
   AND newer."instrumentKey" = older."instrumentKey"
   AND newer."timeframe" = older."timeframe"
   AND (newer."signalTime" > older."signalTime" OR (newer."signalTime" = older."signalTime" AND newer."id" > older."id"))
  WHERE older."status" IN ('WAITING','ENTRY_TRIGGERED','RUNNING','TARGET1_HIT','TARGET2_HIT','TARGET3_HIT')
    AND newer."status" IN ('WAITING','ENTRY_TRIGGERED','RUNNING','TARGET1_HIT','TARGET2_HIT','TARGET3_HIT')
);

CREATE UNIQUE INDEX "AiSignal_one_active_trade_idx"
ON "AiSignal"("userId", "instrumentKey", "timeframe")
WHERE "status" IN ('WAITING','ENTRY_TRIGGERED','RUNNING','TARGET1_HIT','TARGET2_HIT','TARGET3_HIT');
