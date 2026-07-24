CREATE TABLE "HistoricalCandle" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instrumentKey" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "candleTime" DATETIME NOT NULL,
    "open" REAL NOT NULL,
    "high" REAL NOT NULL,
    "low" REAL NOT NULL,
    "close" REAL NOT NULL,
    "volume" REAL NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "HistoricalCandle_instrumentKey_timeframe_candleTime_key"
ON "HistoricalCandle"("instrumentKey", "timeframe", "candleTime");

CREATE INDEX "HistoricalCandle_instrumentKey_timeframe_candleTime_idx"
ON "HistoricalCandle"("instrumentKey", "timeframe", "candleTime");
