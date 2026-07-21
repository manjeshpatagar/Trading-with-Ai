import { Type } from 'class-transformer';
import { IsIn, IsOptional, IsString, Max, Min } from 'class-validator';

export class SearchDto { @IsString() q!: string; }
export class HistoryDto {
  @IsOptional() @IsIn(['minutes']) unit = 'minutes';
  @Type(() => Number) @IsOptional() @IsIn([1, 3, 5, 15, 30]) interval = 5;
  @IsOptional() @IsString() toDate?: string;
  @IsOptional() @IsString() fromDate?: string;
}
export class OhlcDto { @IsOptional() @IsIn(['I1', 'I30']) interval: 'I1' | 'I30' = 'I1'; }
export const INTRADAY_TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m'] as const;
export type IntradayTimeframe = typeof INTRADAY_TIMEFRAMES[number];
export class ChartDto { @IsIn(INTRADAY_TIMEFRAMES) timeframe!: IntradayTimeframe; }
