import { Injectable, Logger } from '@nestjs/common';

/**
 * Fault boundary for per-instrument signal generation. A malformed candle or
 * indicator result must never abort the remaining universe.
 */
@Injectable()
export class SignalEngine {
  private readonly logger = new Logger(SignalEngine.name);

  generate<T>(instrumentKey: string, calculate: () => T | null): T | null {
    try {
      return calculate();
    } catch (error) {
      this.logger.warn(`Signal generation failed | Instrument key: ${instrumentKey} | Error: ${error instanceof Error ? error.message : String(error)} | Continuing scan`);
      return null;
    }
  }
}
