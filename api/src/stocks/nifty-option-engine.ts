/** Rank already validated contracts by execution quality; premium price is not a ranking factor. */
export function rankOptions<T extends {spreadPercent:number;volume:number;strike:number}>(options:T[], underlying:number): T[] {
  return [...options].sort((a,b)=>a.spreadPercent-b.spreadPercent || b.volume-a.volume || Math.abs(a.strike-underlying)-Math.abs(b.strike-underlying));
}
export function optionRiskLevels(entry:number, stopPercent:number, finalR:number) {
  const riskPerUnit=entry*stopPercent/100;
  return {riskPerUnit,stopLoss:entry-riskPerUnit,targets:[entry+riskPerUnit,entry+2*riskPerUnit,entry+finalR*riskPerUnit]};
}
