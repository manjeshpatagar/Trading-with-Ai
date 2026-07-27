CREATE TABLE "StopLossDecision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tradeId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "recoveryProbability" REAL NOT NULL,
    "breakdownProbability" REAL NOT NULL,
    "confidence" REAL NOT NULL,
    "reason" TEXT NOT NULL,
    "recommendation" TEXT NOT NULL,
    "touchedAt" DATETIME NOT NULL,
    "confirmationCandleTime" DATETIME NOT NULL,
    "resolvedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StopLossDecision_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "AiSignal" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "StopLossDecisionEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "decisionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "value" REAL,
    "eventTime" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StopLossDecisionEvent_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "StopLossDecision" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "StopLossDecision_tradeId_key" ON "StopLossDecision"("tradeId");
CREATE INDEX "StopLossDecisionEvent_decisionId_eventTime_idx" ON "StopLossDecisionEvent"("decisionId", "eventTime");
