import { BadRequestException, Controller, Get, HttpException, Logger, Query, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);
  constructor(private readonly auth: AuthService, private readonly config: ConfigService) {}

  @Get('upstox/login')
  login(@Res() response: Response) {
    const state = this.auth.createState();
    response.cookie('upstox_oauth_state', state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.get<string>('NODE_ENV') === 'production',
      maxAge: 10 * 60 * 1000,
    });
    return response.redirect(302, this.auth.authorizationUrl(state));
  }

  @Get('upstox/callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') oauthError: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const frontend = this.config.getOrThrow<string>('WEB_ORIGIN');
    if (oauthError) return response.redirect(302, `${frontend}/?auth_error=${encodeURIComponent(oauthError)}`);
    if (!code) throw new BadRequestException('Upstox did not return an authorization code');

    const cookieState = request.cookies?.upstox_oauth_state as string | undefined;
    if (!state || !cookieState || !this.auth.validState(state, cookieState)) {
      return response.redirect(302, `${frontend}/?auth_error=invalid_oauth_state`);
    }

    try {
      const { user } = await this.auth.exchange(code);
      response.clearCookie('upstox_oauth_state');
      return response.redirect(302, `${frontend}/?session=${encodeURIComponent(this.auth.session(user.id))}`);
    } catch (error) {
      const status = error instanceof HttpException ? error.getStatus() : 500;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Upstox OAuth callback failed (status ${status}): ${message}`, error instanceof Error ? error.stack : undefined);
      response.clearCookie('upstox_oauth_state');
      // The frontend renders this value, so show the provider's actual message
      // (for example UDAPI100069, UDAPI100070, or UDAPI100057), not a generic
      // upstox_token_exchange_failed label.
      return response.redirect(302, `${frontend}/?auth_error=${encodeURIComponent(message)}`);
    }
  }

  @Get('profile')
  async profile(@Req() request: Request) {
    const header = request.headers.authorization;
    const userId = this.auth.userFromSession(header?.replace(/^Bearer\s+/i, ''));
    return this.auth.profile(userId);
  }
}
