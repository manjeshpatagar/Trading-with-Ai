ALTER TABLE "PaperTradingAccount" ADD COLUMN "voiceAlerts" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "PaperTradingAccount" ADD COLUMN "voiceVolume" INTEGER NOT NULL DEFAULT 100;
ALTER TABLE "PaperTradingAccount" ADD COLUMN "voiceSpeed" REAL NOT NULL DEFAULT 1;
ALTER TABLE "PaperTradingAccount" ADD COLUMN "voicePitch" REAL NOT NULL DEFAULT 1;
ALTER TABLE "PaperTradingAccount" ADD COLUMN "voiceLanguage" TEXT NOT NULL DEFAULT 'en-IN';

CREATE TABLE "PaperVoiceAlert" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "tradeId" TEXT NOT NULL,
  "eventName" TEXT NOT NULL,
  "symbol" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "payload" TEXT NOT NULL DEFAULT '{}',
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "spokenAt" DATETIME
);
CREATE UNIQUE INDEX "PaperVoiceAlert_userId_tradeId_eventName_key" ON "PaperVoiceAlert"("userId", "tradeId", "eventName");
CREATE INDEX "PaperVoiceAlert_userId_status_createdAt_idx" ON "PaperVoiceAlert"("userId", "status", "createdAt");
