ALTER TABLE "PaperOrder" ADD COLUMN "niftyDemo" TEXT;
CREATE UNIQUE INDEX "PaperOrder_nifty_one_open" ON "PaperOrder"("userId") WHERE "portfolio" = 'NIFTY' AND "status" = 'OPEN';
