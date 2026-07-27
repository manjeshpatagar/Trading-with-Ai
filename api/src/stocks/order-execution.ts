export type FillRequest = { price: number; quantity: number; at: Date };
export type CloseRequest = { side: string; entryPrice: number; price: number; quantity: number; reason: string; at: Date };
export interface OrderExecution {
  fill(request: FillRequest): Promise<{ entryPrice: number; investment: number; entryTime: Date }>;
  close(request: CloseRequest): Promise<{ exitPrice: number; exitTime: Date; pnl: number; pnlPercent: number; exitReason: string }>;
}
