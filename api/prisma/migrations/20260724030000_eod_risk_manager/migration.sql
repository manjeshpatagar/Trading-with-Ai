ALTER TABLE "PaperOrder" ADD COLUMN "durationMinutes" INTEGER;

CREATE TABLE "EodRiskRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tradingDate" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "brokerOrderIds" TEXT,
    "alert" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "EodRiskRun_tradingDate_userId_scope_key" ON "EodRiskRun"("tradingDate", "userId", "scope");
CREATE INDEX "EodRiskRun_tradingDate_status_idx" ON "EodRiskRun"("tradingDate", "status");
