-- Fractional quantities allow automatic demo positions to invest exactly INR 10,000.
-- Existing integer quantities remain numerically unchanged.
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_PaperOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "signalId" TEXT,
    "instrumentKey" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "confidence" REAL NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "quantity" REAL NOT NULL,
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
    "durationMinutes" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PaperOrder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_PaperOrder"
SELECT "id", "userId", "signalId", "instrumentKey", "symbol", "side", "confidence",
       "status", "quantity", "budget", "plannedEntry", "entryPrice", "currentPrice",
       "investment", "target", "stopLoss", "entryTime", "exitTime", "exitPrice", "pnl",
       "pnlPercent", "exitReason", "durationMinutes", "createdAt", "updatedAt"
FROM "PaperOrder";

DROP TABLE "PaperOrder";
ALTER TABLE "new_PaperOrder" RENAME TO "PaperOrder";
CREATE UNIQUE INDEX "PaperOrder_signalId_key" ON "PaperOrder"("signalId");
CREATE INDEX "PaperOrder_userId_status_idx" ON "PaperOrder"("userId", "status");
CREATE INDEX "PaperOrder_userId_instrumentKey_createdAt_idx" ON "PaperOrder"("userId", "instrumentKey", "createdAt");

PRAGMA foreign_key_check;
PRAGMA foreign_keys=ON;
