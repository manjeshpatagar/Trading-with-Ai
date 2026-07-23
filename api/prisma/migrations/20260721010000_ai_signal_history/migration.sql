CREATE TABLE "AiSignal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "signalKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "instrumentKey" TEXT NOT NULL,
    "stockName" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "strategy" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "signalTime" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "currentPrice" REAL NOT NULL,
    "entryPrice" REAL NOT NULL,
    "stopLoss" REAL NOT NULL,
    "target1" REAL NOT NULL,
    "target2" REAL NOT NULL,
    "target3" REAL NOT NULL,
    "confidence" INTEGER NOT NULL,
    "aiScore" INTEGER NOT NULL,
    "riskReward" REAL NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "entryTriggeredAt" DATETIME,
    "runningAt" DATETIME,
    "target1At" DATETIME,
    "target2At" DATETIME,
    "target3At" DATETIME,
    "stopLossAt" DATETIME,
    "completedAt" DATETIME,
    "profitPercent" REAL,
    "holdingMinutes" INTEGER,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AiSignal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "AiSignal_signalKey_key" ON "AiSignal"("signalKey");
CREATE INDEX "AiSignal_userId_signalTime_idx" ON "AiSignal"("userId", "signalTime");
CREATE INDEX "AiSignal_userId_status_idx" ON "AiSignal"("userId", "status");
CREATE INDEX "AiSignal_instrumentKey_status_idx" ON "AiSignal"("instrumentKey", "status");
