CREATE TABLE "NiftySignalContext" ("signalId" TEXT NOT NULL PRIMARY KEY, "setupId" TEXT NOT NULL, "inputs" TEXT NOT NULL, "optionContract" TEXT NOT NULL, "reasons" TEXT NOT NULL, "invalidations" TEXT NOT NULL, "setupDetectedAt" DATETIME NOT NULL, CONSTRAINT "NiftySignalContext_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "AiSignal" ("id") ON DELETE CASCADE ON UPDATE CASCADE);
CREATE UNIQUE INDEX "NiftySignalContext_setupId_key" ON "NiftySignalContext"("setupId");
CREATE TABLE "NiftyRiskConfiguration" ("userId" TEXT NOT NULL PRIMARY KEY, "settings" TEXT NOT NULL, "updatedAt" DATETIME NOT NULL);
CREATE TABLE "NiftyBacktestResult" ("id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "fromDate" TEXT NOT NULL, "toDate" TEXT NOT NULL, "settings" TEXT NOT NULL, "results" TEXT NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX "NiftyBacktestResult_userId_createdAt_idx" ON "NiftyBacktestResult"("userId", "createdAt");
