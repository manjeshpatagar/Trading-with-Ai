-- New paper accounts start with the configurable demo defaults.
-- Existing account values are preserved.
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_PaperTradingAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "startingBalance" REAL NOT NULL DEFAULT 5000,
    "minimumConfidence" REAL NOT NULL DEFAULT 90,
    "maxOpenTrades" INTEGER NOT NULL DEFAULT 2,
    "riskPerTrade" REAL NOT NULL DEFAULT 2,
    "allowAiWait" BOOLEAN NOT NULL DEFAULT true,
    "allowReentry" BOOLEAN NOT NULL DEFAULT true,
    "realizedPnl" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PaperTradingAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_PaperTradingAccount" SELECT * FROM "PaperTradingAccount";
DROP TABLE "PaperTradingAccount";
ALTER TABLE "new_PaperTradingAccount" RENAME TO "PaperTradingAccount";
CREATE UNIQUE INDEX "PaperTradingAccount_userId_key" ON "PaperTradingAccount"("userId");

PRAGMA foreign_key_check;
PRAGMA foreign_keys=ON;
