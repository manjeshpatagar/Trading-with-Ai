ALTER TABLE "PaperOrder" ADD COLUMN "grossPnl" REAL;
ALTER TABLE "PaperOrder" ADD COLUMN "entryBrokerage" REAL;
ALTER TABLE "PaperOrder" ADD COLUMN "exitBrokerage" REAL;
ALTER TABLE "PaperOrder" ADD COLUMN "otherCharges" REAL;
ALTER TABLE "PaperOrder" ADD COLUMN "totalCharges" REAL;
ALTER TABLE "PaperOrder" ADD COLUMN "netPnl" REAL;
ALTER TABLE "PaperOrder" ADD COLUMN "chargesSource" TEXT;
CREATE INDEX "PaperOrder_userId_portfolio_exitTime_idx" ON "PaperOrder"("userId", "portfolio", "exitTime");
