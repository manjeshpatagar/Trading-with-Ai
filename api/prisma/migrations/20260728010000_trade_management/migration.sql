CREATE TABLE "TradeManagementDecision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tradeId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "confidence" REAL NOT NULL,
    "reentryStatus" TEXT,
    "trailingStop" REAL,
    "partialProfitPercent" REAL NOT NULL DEFAULT 0,
    "evaluatedCandleTime" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TradeManagementDecision_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "AiSignal" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "TradeManagementDecision_tradeId_key" ON "TradeManagementDecision"("tradeId");
