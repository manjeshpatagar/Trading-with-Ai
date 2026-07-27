CREATE TABLE "PaperTradingAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "startingBalance" REAL NOT NULL DEFAULT 10000,
    "minimumConfidence" REAL NOT NULL DEFAULT 90,
    "maxOpenTrades" INTEGER NOT NULL DEFAULT 4,
    "riskPerTrade" REAL NOT NULL DEFAULT 2,
    "allowAiWait" BOOLEAN NOT NULL DEFAULT true,
    "allowReentry" BOOLEAN NOT NULL DEFAULT true,
    "realizedPnl" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PaperTradingAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "PaperOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "instrumentKey" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "confidence" REAL NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "quantity" INTEGER NOT NULL,
    "budget" REAL NOT NULL,
    "plannedEntry" REAL NOT NULL,
    "entryPrice" REAL,
    "currentPrice" REAL NOT NULL,
    "investment" REAL NOT NULL,
    "target" REAL NOT NULL,
    "stopLoss" REAL NOT NULL,
    "entryTime" DATETIME,
    "exitTime" DATETIME,
    "exitPrice" REAL,
    "pnl" REAL NOT NULL DEFAULT 0,
    "pnlPercent" REAL NOT NULL DEFAULT 0,
    "exitReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PaperOrder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PaperTradingAccount_userId_key" ON "PaperTradingAccount"("userId");
CREATE INDEX "PaperOrder_userId_status_idx" ON "PaperOrder"("userId", "status");
CREATE INDEX "PaperOrder_userId_instrumentKey_createdAt_idx" ON "PaperOrder"("userId", "instrumentKey", "createdAt");
