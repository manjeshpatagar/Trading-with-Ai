CREATE TABLE "PostTradeAnalysis" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tradeId" TEXT NOT NULL,
    "entryQuality" TEXT NOT NULL,
    "exitQuality" TEXT NOT NULL,
    "pnlPercent" REAL NOT NULL,
    "exitReason" TEXT NOT NULL,
    "targetProgression" TEXT NOT NULL,
    "entryIndicators" TEXT NOT NULL,
    "exitIndicators" TEXT NOT NULL,
    "marketContext" TEXT NOT NULL,
    "aiSummary" TEXT NOT NULL,
    "keyReasons" TEXT NOT NULL,
    "explanationConfidence" REAL NOT NULL,
    "mistakesDetected" TEXT NOT NULL,
    "suggestedImprovement" TEXT NOT NULL,
    "recoveryProbability" REAL,
    "breakdownProbability" REAL,
    "futureRecommendation" TEXT NOT NULL,
    "specialScenarios" TEXT NOT NULL,
    "newsSentiment" TEXT,
    "analyzedThrough" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PostTradeAnalysis_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "AiSignal" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "PostTradeAnalysis_tradeId_key" ON "PostTradeAnalysis"("tradeId");
