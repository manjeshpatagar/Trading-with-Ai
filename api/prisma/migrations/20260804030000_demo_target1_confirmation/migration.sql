ALTER TABLE "PaperTradingAccount" ADD COLUMN "capitalPerTrade" REAL NOT NULL DEFAULT 10000;
ALTER TABLE "PaperTradingAccount" ADD COLUMN "minimumRiskReward" REAL NOT NULL DEFAULT 3;

ALTER TABLE "PaperOrder" ADD COLUMN "strategy" TEXT NOT NULL DEFAULT 'Target 1 Confirmation';
ALTER TABLE "PaperOrder" ADD COLUMN "entryType" TEXT NOT NULL DEFAULT 'Confirmed Breakout';
ALTER TABLE "PaperOrder" ADD COLUMN "target1Time" DATETIME;
ALTER TABLE "PaperOrder" ADD COLUMN "target2HitAt" DATETIME;
ALTER TABLE "PaperOrder" ADD COLUMN "target3HitAt" DATETIME;
ALTER TABLE "PaperOrder" ADD COLUMN "initialStopLoss" REAL;
ALTER TABLE "PaperOrder" ADD COLUMN "trailingStop" REAL;

CREATE TABLE "DemoExecutionDecision" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "signalId" TEXT NOT NULL,
  "instrumentKey" TEXT NOT NULL,
  "symbol" TEXT NOT NULL,
  "side" TEXT NOT NULL,
  "signalStatus" TEXT NOT NULL,
  "decision" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "currentPrice" REAL NOT NULL,
  "target1Time" DATETIME,
  "confidence" REAL NOT NULL,
  "riskReward" REAL NOT NULL,
  "availableCapital" REAL NOT NULL,
  "capitalPerTrade" REAL NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "DemoExecutionDecision_signalId_decision_reason_key" ON "DemoExecutionDecision"("signalId", "decision", "reason");
CREATE INDEX "DemoExecutionDecision_userId_createdAt_idx" ON "DemoExecutionDecision"("userId", "createdAt");
CREATE INDEX "DemoExecutionDecision_userId_decision_createdAt_idx" ON "DemoExecutionDecision"("userId", "decision", "createdAt");
