CREATE TABLE "RealTradingControl" (
 "userId" TEXT NOT NULL PRIMARY KEY, "strategyEnabledAt" DATETIME, "historyEnabledAt" DATETIME,
 "activeTradeId" TEXT, "lastReleasedAt" DATETIME, "revision" INTEGER NOT NULL DEFAULT 0,
 "leaseOwner" TEXT, "leaseUntil" DATETIME, "updatedAt" DATETIME NOT NULL
);
CREATE TABLE "RealTrade" (
 "id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "signalId" TEXT NOT NULL,
 "source" TEXT NOT NULL, "instrumentKey" TEXT NOT NULL, "symbol" TEXT NOT NULL, "side" TEXT NOT NULL,
 "target" REAL NOT NULL, "stopLoss" REAL NOT NULL, "hitAt" DATETIME NOT NULL, "status" TEXT NOT NULL,
 "quantity" INTEGER NOT NULL DEFAULT 0, "entryPrice" REAL, "exitPrice" REAL, "entryTime" DATETIME,
 "exitTime" DATETIME, "exitReason" TEXT, "error" TEXT,
 "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "RealTrade_userId_signalId_key" ON "RealTrade"("userId", "signalId");
CREATE INDEX "RealTrade_userId_status_idx" ON "RealTrade"("userId", "status");
CREATE TABLE "RealOrderAttempt" (
 "id" TEXT NOT NULL PRIMARY KEY, "tradeId" TEXT NOT NULL, "kind" TEXT NOT NULL,
 "tag" TEXT NOT NULL, "brokerOrderId" TEXT, "quantity" INTEGER NOT NULL,
 "filledQuantity" INTEGER NOT NULL DEFAULT 0, "averagePrice" REAL NOT NULL DEFAULT 0,
 "status" TEXT NOT NULL DEFAULT 'SUBMITTING', "error" TEXT,
 "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL,
 CONSTRAINT "RealOrderAttempt_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "RealTrade"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "RealOrderAttempt_tag_key" ON "RealOrderAttempt"("tag");
CREATE UNIQUE INDEX "RealOrderAttempt_brokerOrderId_key" ON "RealOrderAttempt"("brokerOrderId");
CREATE INDEX "RealOrderAttempt_tradeId_kind_idx" ON "RealOrderAttempt"("tradeId", "kind");
