import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { IndicatorService } from './indicator.service';
import { MarketGateway } from './market.gateway';
import { StocksController } from './stocks.controller';
import { UpstoxService } from './upstox.service';
import { ScannerService } from './scanner.service';
import { SignalHistoryService } from './signal-history.service';
import { StopLossDecisionService } from './stop-loss-decision.service';
import { PaperOrderExecutionService } from './paper-order-execution.service';
import { PaperTradingService } from './paper-trading.service';
import { EodRiskManagerService } from './eod-risk-manager.service';

@Module({
  imports: [AuthModule],
  controllers: [StocksController],
  providers: [UpstoxService, IndicatorService, MarketGateway, ScannerService, SignalHistoryService, StopLossDecisionService, PaperOrderExecutionService, PaperTradingService, EodRiskManagerService],
})
export class StocksModule {}
