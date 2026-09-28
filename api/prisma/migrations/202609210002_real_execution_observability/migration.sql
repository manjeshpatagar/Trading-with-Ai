CREATE TABLE "RealExecutionEvent" (
 "id" TEXT NOT NULL PRIMARY KEY, "tradeId" TEXT NOT NULL, "key" TEXT NOT NULL,
 "type" TEXT NOT NULL, "observedAt" DATETIME NOT NULL, "origin" TEXT NOT NULL,
 "detail" TEXT NOT NULL, "brokerTimestamp" TEXT,
 CONSTRAINT "RealExecutionEvent_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "RealTrade"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "RealExecutionEvent_tradeId_key_key" ON "RealExecutionEvent"("tradeId", "key");
CREATE INDEX "RealExecutionEvent_tradeId_observedAt_idx" ON "RealExecutionEvent"("tradeId", "observedAt");
CREATE TABLE "RealSignalDecision" (
 "id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "signalId" TEXT NOT NULL,
 "source" TEXT NOT NULL, "symbol" TEXT NOT NULL, "side" TEXT NOT NULL,
 "hitAt" DATETIME NOT NULL, "observedAt" DATETIME NOT NULL, "eligibleAtHit" BOOLEAN NOT NULL,
 "enabledAt" DATETIME, "code" TEXT NOT NULL, "reason" TEXT NOT NULL, "tradeId" TEXT,
 CONSTRAINT "RealSignalDecision_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "RealTrade"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "RealSignalDecision_userId_signalId_source_key" ON "RealSignalDecision"("userId", "signalId", "source");
CREATE INDEX "RealSignalDecision_userId_hitAt_idx" ON "RealSignalDecision"("userId", "hitAt");
