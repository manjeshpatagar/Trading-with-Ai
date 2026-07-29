import { Injectable, Logger } from '@nestjs/common';
import { Candle, IndicatorService } from './indicator.service';

@Injectable()
export class IndicatorEngine {
  private readonly logger = new Logger(IndicatorEngine.name);

  constructor(private readonly indicators: IndicatorService) {}

  calculate(candles: Candle[]) {
    try {
      return this.indicators.calculate(candles);
    } catch (error) {
      this.logger.warn(`Indicator calculation failed; instrument will be skipped: ${error instanceof Error ? error.message : String(error)}`);
      return {};
    }
  }
}
