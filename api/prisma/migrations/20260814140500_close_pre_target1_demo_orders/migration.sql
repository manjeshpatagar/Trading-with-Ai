-- Reconcile positions created by the retired RUNNING-stage demo executor.
-- Preserve every order in history, but release capital when no Target 1 event
-- existed at or before its entry time.
UPDATE "PaperOrder"
SET
  "status" = 'CLOSED',
  "exitPrice" = "currentPrice",
  "exitTime" = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  "exitReason" = 'RULE CHANGE - TARGET 1 REQUIRED',
  "durationMinutes" = CASE
    WHEN "entryTime" IS NULL THEN 0
    ELSE MAX(0, CAST((CAST(strftime('%s', 'now') AS INTEGER) * 1000 - "entryTime") / 60000 AS INTEGER))
  END,
  "updatedAt" = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE "status" = 'OPEN'
  AND (
    "signalId" IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM "AiSignal"
      WHERE "AiSignal"."id" = "PaperOrder"."signalId"
        AND "AiSignal"."target1At" IS NOT NULL
        AND ("PaperOrder"."entryTime" IS NULL OR "AiSignal"."target1At" <= "PaperOrder"."entryTime")
    )
  );

UPDATE "DemoTradeQueue"
SET
  "status" = 'REJECTED',
  "rejectedAt" = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  "rejectReason" = 'Legacy queue entry: Target 1 was not reached'
WHERE "status" = 'WAITING_FOR_CAPITAL'
  AND NOT EXISTS (
    SELECT 1
    FROM "AiSignal"
    WHERE "AiSignal"."id" = "DemoTradeQueue"."signalId"
      AND "AiSignal"."status" = 'TARGET1_HIT'
      AND "AiSignal"."target1At" IS NOT NULL
  );
