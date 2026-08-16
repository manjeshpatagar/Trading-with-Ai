-- Demo/paper state reset only. AI signals, market data, users, tokens and real trades are untouched.
DELETE FROM "PaperOrder";
DELETE FROM "DemoTradeQueue";
UPDATE "PaperTradingAccount"
SET "startingBalance" = 10000,
    "realizedPnl" = 0,
    "maxOpenTrades" = 1,
    "autoDemoTrading" = true;
