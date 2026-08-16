-- Demo execution candidates must belong to the current IST trading day.
UPDATE "PaperOrder"
SET
  "status" = 'CLOSED',
  "exitPrice" = "currentPrice",
  "exitTime" = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  "exitReason" = 'HISTORICAL SIGNAL - NOT LIVE',
  "durationMinutes" = CASE
    WHEN "entryTime" IS NULL THEN 0
    ELSE MAX(0, CAST((CAST(strftime('%s', 'now') AS INTEGER) * 1000 - "entryTime") / 60000 AS INTEGER))
  END,
  "updatedAt" = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE "status" = 'OPEN'
  AND NOT EXISTS (
    SELECT 1 FROM "AiSignal"
    WHERE "AiSignal"."id" = "PaperOrder"."signalId"
      AND date("AiSignal"."signalTime" / 1000, 'unixepoch', '+330 minutes') = date('now', '+330 minutes')
      AND "AiSignal"."target1At" IS NOT NULL
      AND "AiSignal"."target1At" <= "PaperOrder"."entryTime"
  );

UPDATE "DemoTradeQueue"
SET
  "status" = 'REJECTED',
  "rejectedAt" = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  "rejectReason" = 'Historical signal: not from the current IST trading day'
WHERE "status" = 'WAITING_FOR_CAPITAL'
  AND NOT EXISTS (
    SELECT 1 FROM "AiSignal"
    WHERE "AiSignal"."id" = "DemoTradeQueue"."signalId"
      AND date("AiSignal"."signalTime" / 1000, 'unixepoch', '+330 minutes') = date('now', '+330 minutes')
      AND "AiSignal"."status" = 'TARGET1_HIT'
      AND "AiSignal"."target1At" IS NOT NULL
  );
