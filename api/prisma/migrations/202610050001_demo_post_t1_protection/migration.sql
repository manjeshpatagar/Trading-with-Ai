-- Demo-only protection; existing positions retain their current behavior.
ALTER TABLE "PaperOrder" ADD COLUMN "postT1ProtectionActive" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PaperOrder" ADD COLUMN "protectedStopLoss" REAL;
ALTER TABLE "PaperOrder" ADD COLUMN "postT1ProtectionState" TEXT;
