import { Injectable } from '@nestjs/common';
import { LiveQuote } from './quote-batch.service';

@Injectable()
export class AiRankingEngine {
  rankUniverse<T extends { instrumentKey: string }>(candidates: T[], live: Map<string, LiveQuote>) {
    const rank = (value: number, values: number[]) => values.length <= 1 ? 1 : values.filter((item) => item <= value).length / values.length;
    const quotes = candidates.map((item) => live.get(item.instrumentKey)!);
    const liquidity = quotes.map((quote) => quote.price * quote.volume);
    const volumes = quotes.map((quote) => quote.volume);
    const volatility = quotes.map((quote) => Math.abs(quote.changePercent));
    const positiveVolumes = volumes.filter((value) => value > 0).sort((a, b) => a - b);
    const typicalVolume = positiveVolumes[Math.floor(positiveVolumes.length / 2)] || 1;
    return candidates.map((instrument, index) => {
      const quote = quotes[index];
      const relativeVolume = quote.volume / typicalVolume;
      const aiPreScore = .45 * rank(liquidity[index], liquidity) + .25 * rank(quote.volume, volumes) + .2 * rank(volatility[index], volatility) + .1 * Math.min(relativeVolume / 2, 1);
      return { ...instrument, selectionScore: Math.round(aiPreScore * 10000) / 100 };
    }).sort((a, b) => b.selectionScore - a.selectionScore);
  }

  top<T extends { aiScore: number; signal: string }>(rows: T[], side: 'BUY' | 'SELL', limit = 10) {
    return rows.filter((row) => row.signal === side).sort((a, b) => b.aiScore - a.aiScore).slice(0, limit);
  }
}
