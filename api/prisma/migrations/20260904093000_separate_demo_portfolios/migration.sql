PRAGMA foreign_keys=OFF;

CREATE TABLE "new_PaperTradingAccount" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "portfolio" TEXT NOT NULL DEFAULT 'STRATEGY',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "autoDemoTrading" BOOLEAN NOT NULL DEFAULT false,
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
INSERT INTO "new_PaperTradingAccount" SELECT "id", "userId", 'STRATEGY', "enabled", "autoDemoTrading", "startingBalance", "minimumConfidence", "maxOpenTrades", "riskPerTrade", "allowAiWait", "allowReentry", "realizedPnl", "createdAt", "updatedAt" FROM "PaperTradingAccount";
DROP TABLE "PaperTradingAccount";
ALTER TABLE "new_PaperTradingAccount" RENAME TO "PaperTradingAccount";
CREATE UNIQUE INDEX "PaperTradingAccount_userId_portfolio_key" ON "PaperTradingAccount"("userId", "portfolio");

DROP INDEX "PaperOrder_signalId_key";
ALTER TABLE "PaperOrder" ADD COLUMN "portfolio" TEXT NOT NULL DEFAULT 'STRATEGY';
CREATE UNIQUE INDEX "PaperOrder_signalId_portfolio_key" ON "PaperOrder"("signalId", "portfolio");

DROP INDEX "DemoTradeQueue_signalId_key";
ALTER TABLE "DemoTradeQueue" ADD COLUMN "portfolio" TEXT NOT NULL DEFAULT 'STRATEGY';
CREATE UNIQUE INDEX "DemoTradeQueue_signalId_portfolio_key" ON "DemoTradeQueue"("signalId", "portfolio");

PRAGMA foreign_key_check;
PRAGMA foreign_keys=ON;
