ALTER TABLE "RealTradeQueue" ADD COLUMN "displayStatus" TEXT NOT NULL DEFAULT 'Waiting';
ALTER TABLE "RealTradeQueue" ADD COLUMN "validationLog" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "RealTradeQueue" ADD COLUMN "brokerResponse" TEXT;
