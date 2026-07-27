import { Injectable, Logger } from '@nestjs/common';
import { CloseRequest, FillRequest, OrderExecution } from './order-execution';

@Injectable()
export class PaperOrderExecutionService implements OrderExecution {
  private readonly logger = new Logger(PaperOrderExecutionService.name);

  async fill(request: FillRequest) {
    try {
      const price = Number.isFinite(request.price) ? request.price : 0;
      const quantity = Number.isFinite(request.quantity) ? request.quantity : 0;
      return { entryPrice: price, investment: price * quantity, entryTime: request.at };
    } catch (error) {
      this.logError('paper.execution.fill.failed', error);
      return { entryPrice: 0, investment: 0, entryTime: request.at };
    }
  }
  async close(request: CloseRequest) {
    try {
      const price = Number.isFinite(request.price) ? request.price : 0;
      const entryPrice = Number.isFinite(request.entryPrice) ? request.entryPrice : 0;
      const quantity = Number.isFinite(request.quantity) ? request.quantity : 0;
      const pnl = (request.side === 'BUY' ? price - entryPrice : entryPrice - price) * quantity;
      return { exitPrice: price, exitTime: request.at, pnl: Number.isFinite(pnl) ? pnl : 0, pnlPercent: entryPrice && quantity ? pnl / (entryPrice * quantity) * 100 : 0, exitReason: request.reason };
    } catch (error) {
      this.logError('paper.execution.close.failed', error);
      return { exitPrice: 0, exitTime: request.at, pnl: 0, pnlPercent: 0, exitReason: request.reason };
    }
  }

  private logError(event: string, error: unknown) {
    const exception = error instanceof Error ? error : new Error(String(error));
    this.logger.error(
      JSON.stringify({ event, exceptionName: exception.name, message: exception.message, stack: exception.stack }),
      exception.stack,
    );
  }
}
