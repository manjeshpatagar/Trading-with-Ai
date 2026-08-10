import { Injectable } from '@nestjs/common';
export type ExecutionState = 'SIGNAL_CREATED'|'VALIDATING'|'WAITING'|'QUALIFIED'|'EXECUTING'|'RUNNING'|'TARGET_1'|'TARGET_2'|'TARGET_3'|'STOP_LOSS'|'EXITING'|'COMPLETED'|'RETRYING'|'EXECUTION_FAILED'|'EXPIRED';
export type ExecutionPriority = 'HIGH'|'MEDIUM'|'LOW';
export type ExecutionCandidate = { side:string; strategy?:string|null; signalTime:Date; currentPrice:number; entryPrice:number; stopLoss:number; target1:number; target2:number; target3:number; confidence:number; aiScore:number; riskReward:number; volumeRatio?:number; volumeIncreasing?:boolean; marketTrendAligned?:boolean; sectorStrength?:number; entryQuality?:number };
export type ExecutionContext = { now:Date; marketOpen:boolean; emergencyStop?:boolean; brokerAvailable?:boolean; availableCapital:number; affordableQuantity?:number; tradingCapital:number; riskPercent:number; openTrades:number; maxOpenTrades:number; dailyLoss:number; maximumDailyLoss:number; duplicatePosition?:boolean; minimumConfidence?:number; minimumRiskReward?:number; allowMedium?:boolean; maxEntryDeviationPercent?:number };
const TRANSITIONS: Record<ExecutionState,ExecutionState[]> = { SIGNAL_CREATED:['VALIDATING'],VALIDATING:['WAITING','QUALIFIED','EXPIRED'],WAITING:['VALIDATING','QUALIFIED','EXPIRED'],QUALIFIED:['EXECUTING','WAITING'],EXECUTING:['RUNNING','RETRYING','EXECUTION_FAILED'],RETRYING:['EXECUTING','EXECUTION_FAILED'],RUNNING:['TARGET_1','STOP_LOSS','EXITING'],TARGET_1:['TARGET_2','STOP_LOSS','EXITING'],TARGET_2:['TARGET_3','STOP_LOSS','EXITING'],TARGET_3:['EXITING'],STOP_LOSS:['EXITING'],EXITING:['COMPLETED','RETRYING'],COMPLETED:[],EXECUTION_FAILED:[],EXPIRED:[] };
@Injectable()
export class ExecutionEngine {
  private readonly executions = new Map<string, unknown>();
  decide(s:ExecutionCandidate,c:ExecutionContext) {
    const ageMs=Math.max(0,c.now.getTime()-s.signalTime.getTime()), entryDeviation=s.entryPrice>0?Math.abs(s.currentPrice-s.entryPrice)/s.entryPrice:Infinity, tolerance=(c.maxEntryDeviationPercent??.3)/100, hardBlocker=this.hardBlocker(s,c), priority=this.priority(s), quantity=this.quantity(s,c);
    const result=(action:'EXECUTE'|'WAIT'|'REVALIDATE'|'RECALCULATE'|'SKIP',reason:string,hard:string|null=hardBlocker)=>({action,state:action==='EXECUTE'?'QUALIFIED' as const:'WAITING' as const,reason,hardBlocker:hard,priority,quantity,ageMs,entryDeviation});
    if(hardBlocker)return result('SKIP',hardBlocker); if(!quantity)return result('SKIP','Insufficient capital for minimum quantity','Insufficient capital');
    if(s.confidence<(c.minimumConfidence??85))return result('REVALIDATE',`Confidence ${s.confidence}% is temporarily below ${c.minimumConfidence??85}%`,null);
    if(s.riskReward<(c.minimumRiskReward??2.5))return result('RECALCULATE','Risk/reward requires recalculation at the live price',null);
    if(entryDeviation>tolerance)return result('RECALCULATE',`Entry deviation ${(entryDeviation*100).toFixed(3)}% exceeds ${(tolerance*100).toFixed(3)}%`,null);
    if(ageMs>=15_000)return result('RECALCULATE','Signal entry must be recalculated with live price',null); if(ageMs>=5_000)return result('REVALIDATE','Signal requires live revalidation',null);
    if(priority==='LOW'||(priority==='MEDIUM'&&!c.allowMedium))return result('WAIT',priority==='LOW'?'Low-priority signal is not executable':'Medium-priority execution is disabled',null);
    return result('EXECUTE','All mandatory execution conditions passed',null);
  }
  priority(s:ExecutionCandidate):ExecutionPriority { if(s.confidence>=90&&s.riskReward>=3&&Number(s.volumeRatio??0)>=1&&s.marketTrendAligned)return'HIGH'; if(s.confidence>=85&&s.riskReward>=2.5)return'MEDIUM'; return'LOW'; }
  rank(s:ExecutionCandidate){const p=(v:number)=>Math.max(0,Math.min(100,Number(v)||0));return Number((p(s.riskReward/5*100)*.30+p(s.confidence)*.25+p(s.entryQuality??s.aiScore)*.15+p(Number(s.volumeRatio??0)/3*100)*.10+(s.marketTrendAligned?10:0)+p(Number(s.sectorStrength??0))*.05+p(s.aiScore)*.05).toFixed(4));}
  quantity(s:ExecutionCandidate,c:ExecutionContext){const d=Math.abs(s.currentPrice-s.stopLoss);if(!(d>0)||!(s.currentPrice>0))return 0;const riskQuantity=Math.floor(Math.max(0,c.tradingCapital)*Math.max(0,c.riskPercent)/100/d),capitalQuantity=c.affordableQuantity==null?Math.floor(Math.max(0,c.availableCapital)/s.currentPrice):Math.max(0,Math.floor(c.affordableQuantity));return Math.max(0,Math.min(riskQuantity,capitalQuantity));}
  canTransition(from:ExecutionState,to:ExecutionState){return TRANSITIONS[from].includes(to);} assertTransition(from:ExecutionState,to:ExecutionState){if(!this.canTransition(from,to))throw new Error(`Invalid execution transition: ${from} -> ${to}`);}
  exitDecision(side:string,price:number,stopLoss:number,target1:number,target2:number,target3:number,current:ExecutionState='RUNNING') {
    const crossed=(level:number)=>side==='BUY'?price>=level:price<=level, stopped=side==='BUY'?price<=stopLoss:price>=stopLoss;
    if(stopped)return{state:'STOP_LOSS' as const,close:true,reason:'STOP_LOSS'};
    if(crossed(target3))return{state:'TARGET_3' as const,close:true,reason:'TARGET_3'};
    if(crossed(target2)&&['RUNNING','TARGET_1'].includes(current))return{state:'TARGET_2' as const,close:false,reason:'TARGET_2'};
    if(crossed(target1)&&current==='RUNNING')return{state:'TARGET_1' as const,close:false,reason:'TARGET_1'};
    return{state:current,close:false,reason:'HOLD'};
  }
  async executeWithRetry<T>(executionId:string,operation:()=>Promise<T>,retryLimit=3):Promise<T>{
    if(this.executions.has(executionId))return this.executions.get(executionId) as T;
    let last:unknown; for(let attempt=1;attempt<=Math.max(1,retryLimit);attempt++){try{const result=await operation();this.executions.set(executionId,result);return result;}catch(error){last=error;}}
    throw last;
  }
  private hardBlocker(s:ExecutionCandidate,c:ExecutionContext){if(!c.marketOpen)return'Market closed';if(c.emergencyStop)return'Emergency stop enabled';if(c.brokerAvailable===false)return'Broker unavailable';if(c.maxOpenTrades>0&&c.openTrades>=c.maxOpenTrades)return'Maximum open trades reached';if(c.dailyLoss>=c.maximumDailyLoss)return'Daily loss limit reached';if(c.duplicatePosition)return'Duplicate position';if(!['BUY','SELL'].includes(s.side))return'Invalid direction';if(![s.currentPrice,s.entryPrice,s.stopLoss,s.target1,s.target2,s.target3].every(v=>Number.isFinite(v)&&v>0))return'Invalid price';if(s.side==='BUY'?s.stopLoss>=s.currentPrice:s.stopLoss<=s.currentPrice)return'Invalid stop loss';return null;}
}
