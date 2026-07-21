import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { IndicatorService } from './indicator.service';
import { MarketGateway } from './market.gateway';
import { StocksController } from './stocks.controller';
import { UpstoxService } from './upstox.service';
import { ScannerService } from './scanner.service';

@Module({
  imports: [AuthModule],
  controllers: [StocksController],
  providers: [UpstoxService, IndicatorService, MarketGateway, ScannerService],
})
export class StocksModule {}
