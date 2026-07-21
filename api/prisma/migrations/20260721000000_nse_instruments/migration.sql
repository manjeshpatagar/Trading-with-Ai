CREATE TABLE "NseInstrument" (
    "instrumentKey" TEXT NOT NULL PRIMARY KEY,
    "symbol" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "isin" TEXT,
    "company" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" DATETIME NOT NULL
);

CREATE INDEX "NseInstrument_symbol_idx" ON "NseInstrument"("symbol");
CREATE INDEX "NseInstrument_active_idx" ON "NseInstrument"("active");
