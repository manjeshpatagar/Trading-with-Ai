import { BadRequestException, Body, Controller, Get, Headers, Patch, Post, Query } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { NiftyDemoService } from './nifty-demo.service';
import { NiftyService } from './nifty.service';
@Controller('nifty')
export class NiftyController {
  constructor(private readonly auth: AuthService, private readonly nifty: NiftyService, private readonly demo: NiftyDemoService) { }
  private user(header: string | undefined) { return this.auth.userFromSession(header?.replace(/^Bearer\s+/i, '')); }
  @Get('demo')
  async demoView(@Headers('authorization') h: string | undefined) { const userId = this.user(h); const market = await this.nifty.view(userId); return { ...await this.demo.view(userId), analysis: market }; }
  @Get('market')
  market(
  @Headers('authorization')
  h: string | undefined) { return this.nifty.view(this.user(h)); }
  @Get('candles')
  candles(
  @Headers('authorization')
  h: string | undefined, 
  @Query('timeframe')
  tf = '15') { return this.nifty.candles(this.user(h), Number(tf)); }
  @Get('health')
  async health(@Headers('authorization') h:string|undefined) { return (await this.nifty.view(this.user(h))).dataHealth; }
  @Post('demo/exit')
  async exit(@Headers('authorization') h:string|undefined) { return this.demo.invalidateSetup(this.user(h),'MANUAL EXIT'); }
  @Get('levels')
  async levels(
  @Headers('authorization')
  h: string | undefined) { return (await this.nifty.view(this.user(h))).levels; }
  @Get('regime')
  async regime(
  @Headers('authorization')
  h: string | undefined) { const v = await this.nifty.view(this.user(h)); return { regime: v.regime, timeframes: v.timeframes }; }
  @Get('strategies')
  async strategies(
  @Headers('authorization')
  h: string | undefined) { return (await this.nifty.view(this.user(h))).strategies; }
  @Get('setup')
  async setup(
  @Headers('authorization')
  h: string | undefined) { const v = await this.nifty.view(this.user(h)); return { setup: v.setup, noTradeReasons: v.noTradeReasons, option: v.option }; }
  @Get('signals')
  signals(
  @Headers('authorization')
  h: string | undefined, 
  @Query()
  q: Record<string, string>) { this.validateDates(q); return this.nifty.history(this.user(h), q); }
  @Get('performance')
  performance(
  @Headers('authorization')
  h: string | undefined, 
  @Query()
  q: Record<string, string>) { this.validateDates(q); return this.nifty.performance(this.user(h), q); }
  @Get('settings')
  settings(
  @Headers('authorization')
  h: string | undefined) { return this.nifty.settings(this.user(h)); }
  @Patch('settings')
  save(
  @Headers('authorization')
  h: string | undefined, 
  @Body()
  body: Record<string, unknown>) { return this.nifty.saveSettings(this.user(h), body); }
  @Get('backtest')
  backtest(
  @Headers('authorization')
  h: string | undefined, 
  @Query('from')
  from: string, 
  @Query('to')
  to: string, @Query() filters: Record<string,string>) { return this.nifty.backtest(this.user(h), from ?? '', to ?? '', filters); }
  private validateDates(q: Record<string, string>) { for (const key of ['from', 'to'])
    if (q[key] && !/^\d{4}-\d{2}-\d{2}$/.test(q[key]))
      throw new BadRequestException('Dates must use YYYY-MM-DD'); }
}
