ALTER TABLE "PaperTradingAccount" ADD COLUMN "autoDemoTrading" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "PaperOrder" ADD COLUMN "signalId" TEXT;

CREATE UNIQUE INDEX "PaperOrder_signalId_key" ON "PaperOrder"("signalId");

CREATE TABLE "DemoTradeQueue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "signalId" TEXT NOT NULL,
    "instrumentKey" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "entryPrice" REAL NOT NULL,
    "confidence" REAL NOT NULL,
    "aiScore" REAL NOT NULL,
    "riskReward" REAL NOT NULL,
    "signalTime" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'WAITING_FOR_CAPITAL',
    "queuedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "executedAt" DATETIME,
    "rejectedAt" DATETIME,
    "rejectReason" TEXT,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "DemoTradeQueue_signalId_key" ON "DemoTradeQueue"("signalId");
CREATE INDEX "DemoTradeQueue_userId_status_confidence_aiScore_idx" ON "DemoTradeQueue"("userId", "status", "confidence", "aiScore");
