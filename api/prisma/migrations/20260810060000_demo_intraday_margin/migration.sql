ALTER TABLE "PaperOrder" ADD COLUMN "product" TEXT NOT NULL DEFAULT 'I';
ALTER TABLE "PaperOrder" ADD COLUMN "productType" TEXT NOT NULL DEFAULT 'INTRADAY';
ALTER TABLE "PaperOrder" ADD COLUMN "notionalValue" REAL NOT NULL DEFAULT 0;
ALTER TABLE "PaperOrder" ADD COLUMN "requiredIntradayMargin" REAL NOT NULL DEFAULT 0;
ALTER TABLE "PaperOrder" ADD COLUMN "availableCapitalAtEntry" REAL NOT NULL DEFAULT 0;
ALTER TABLE "PaperOrder" ADD COLUMN "marginPerShare" REAL NOT NULL DEFAULT 0;
ALTER TABLE "PaperOrder" ADD COLUMN "maximumMarginQuantity" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PaperOrder" ADD COLUMN "riskAmount" REAL NOT NULL DEFAULT 0;
ALTER TABLE "PaperOrder" ADD COLUMN "riskPerShare" REAL NOT NULL DEFAULT 0;
ALTER TABLE "PaperOrder" ADD COLUMN "riskBasedQuantity" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PaperOrder" ADD COLUMN "estimatedCharges" REAL NOT NULL DEFAULT 0;
ALTER TABLE "PaperOrder" ADD COLUMN "expectedGrossProfit" REAL NOT NULL DEFAULT 0;
ALTER TABLE "PaperOrder" ADD COLUMN "expectedNetProfit" REAL NOT NULL DEFAULT 0;
ALTER TABLE "PaperOrder" ADD COLUMN "grossPnl" REAL NOT NULL DEFAULT 0;
ALTER TABLE "PaperOrder" ADD COLUMN "netPnl" REAL NOT NULL DEFAULT 0;

UPDATE "PaperOrder"
SET "product" = 'I', "productType" = 'INTRADAY', "notionalValue" = "investment"
WHERE "product" <> 'I' OR "productType" <> 'INTRADAY' OR "notionalValue" = 0;
