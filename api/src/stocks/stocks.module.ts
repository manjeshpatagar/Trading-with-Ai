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
import { QuoteBatchService } from './quote-batch.service';
import { IndicatorEngine } from './indicator-engine.service';
import { AiRankingEngine } from './ai-ranking-engine.service';
import { SignalEngine } from './signal-engine.service';
import { RealTradingService } from './real-trading.service';
import { TradeManagementService } from './trade-management.service';
import { DemoTradingWorkerService } from './demo-trading-worker.service';

@Module({
  imports: [AuthModule],
  controllers: [StocksController],
  providers: [UpstoxService, QuoteBatchService, IndicatorService, IndicatorEngine, SignalEngine, AiRankingEngine, TradeManagementService, MarketGateway, ScannerService, SignalHistoryService, StopLossDecisionService, PaperOrderExecutionService, PaperTradingService, RealTradingService, EodRiskManagerService, DemoTradingWorkerService],
})
export class StocksModule {}
