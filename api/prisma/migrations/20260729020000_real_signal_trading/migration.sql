CREATE TABLE "RealTradingAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "tradingCapital" REAL NOT NULL DEFAULT 10000,
    "maxOpenTrades" INTEGER NOT NULL DEFAULT 1,
    "riskPerTrade" REAL NOT NULL DEFAULT 1,
    "maxDailyLoss" REAL NOT NULL DEFAULT 1000,
    "maxDailyProfit" REAL NOT NULL DEFAULT 2000,
    "autoTrading" BOOLEAN NOT NULL DEFAULT false,
    "buySignals" BOOLEAN NOT NULL DEFAULT true,
    "sellSignals" BOOLEAN NOT NULL DEFAULT true,
    "squareOffTime" TEXT NOT NULL DEFAULT '15:15',
    "connectionTime" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "RealTradingAccount_userId_key" ON "RealTradingAccount"("userId");

CREATE TABLE "RealTradeOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "signalId" TEXT NOT NULL,
    "brokerOrderId" TEXT,
    "instrumentKey" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "entryPrice" REAL NOT NULL,
    "currentPrice" REAL NOT NULL,
    "quantity" INTEGER NOT NULL,
    "allocatedCapital" REAL NOT NULL,
    "investment" REAL NOT NULL,
    "target1" REAL NOT NULL,
    "target2" REAL NOT NULL,
    "target3" REAL NOT NULL,
    "stopLoss" REAL NOT NULL,
    "currentStop" REAL NOT NULL,
    "targetProgress" TEXT NOT NULL DEFAULT 'ENTRY',
    "pnl" REAL NOT NULL DEFAULT 0,
    "pnlPercent" REAL NOT NULL DEFAULT 0,
    "executionTime" DATETIME,
    "exitPrice" REAL,
    "exitReason" TEXT,
    "exitTime" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "RealTradeOrder_signalId_key" ON "RealTradeOrder"("signalId");
CREATE UNIQUE INDEX "RealTradeOrder_brokerOrderId_key" ON "RealTradeOrder"("brokerOrderId");
CREATE INDEX "RealTradeOrder_userId_status_idx" ON "RealTradeOrder"("userId", "status");

CREATE TABLE "RealTradeQueue" (
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
    "status" TEXT NOT NULL DEFAULT 'WAITING_FOR_SLOT',
    "queuedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME,
    "reason" TEXT,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "RealTradeQueue_signalId_key" ON "RealTradeQueue"("signalId");
CREATE INDEX "RealTradeQueue_userId_status_confidence_aiScore_idx" ON "RealTradeQueue"("userId", "status", "confidence", "aiScore");
