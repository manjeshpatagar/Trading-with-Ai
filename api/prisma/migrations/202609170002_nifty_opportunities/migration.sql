CREATE TABLE "NiftyOpportunity" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "userId" TEXT NOT NULL,
 "setupId" TEXT NOT NULL,
 "strategy" TEXT NOT NULL,
 "side" TEXT NOT NULL,
 "detectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "score" INTEGER NOT NULL
);
CREATE UNIQUE INDEX "NiftyOpportunity_userId_setupId_key" ON "NiftyOpportunity"("userId", "setupId");
CREATE INDEX "NiftyOpportunity_userId_detectedAt_idx" ON "NiftyOpportunity"("userId", "detectedAt");
