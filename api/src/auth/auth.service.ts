import { BadGatewayException, Injectable, InternalServerErrorException, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { PrismaService } from '../prisma.service';

const API = 'https://api.upstox.com/v2';
type UpstoxToken = { access_token: string; user_id?: string; email?: string; user_name?: string; expires_at?: string | number };
type UpstoxClaims = { user_id?: string; email?: string; user_name?: string; exp?: number; iat?: number };

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService) {}

  createState() {
    return crypto.randomBytes(32).toString('base64url');
  }

  validState(received: string, expected: string) {
    const receivedBuffer = Buffer.from(received);
    const expectedBuffer = Buffer.from(expected);
    return receivedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
  }

  authorizationUrl(state: string) {
  const parameters = new URLSearchParams({
    response_type: 'code',
    client_id: this.required('UPSTOX_CLIENT_ID'),
    redirect_uri: this.required('UPSTOX_REDIRECT_URI'),
    state,
  });

  const url = `${API}/login/authorization/dialog?${parameters}`;

  console.log('Upstox Login URL:');
  console.log(url);

  return url;
}

  private required(name: string) {
    const value = this.config.get<string>(name)?.trim();
    if (!value) throw new InternalServerErrorException(`${name} is not configured`);
    return value;
  }

  private key() {
    return crypto.createHash('sha256').update(this.required('TOKEN_ENCRYPTION_KEY')).digest();
  }

  encrypt(value: string) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key(), iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.');
  }

  decrypt(value: string) {
    const [iv, tag, ciphertext] = value.split('.').map((part) => Buffer.from(part, 'base64'));
    if (!iv || !tag || !ciphertext) throw new UnauthorizedException('Stored Upstox token is invalid');
    const cipher = crypto.createDecipheriv('aes-256-gcm', this.key(), iv);
    cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(ciphertext), cipher.final()]).toString('utf8');
  }

  async exchange(code: string) {
    const form = new URLSearchParams({
      code,
      client_id: this.required('UPSTOX_CLIENT_ID'),
      client_secret: this.required('UPSTOX_CLIENT_SECRET'),
      redirect_uri: this.required('UPSTOX_REDIRECT_URI'),
      grant_type: 'authorization_code',
    });
    const tokenUrl = `${API}/login/authorization/token`;
    const requestHeaders = {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    // Authorization codes and client secrets are credentials. Log the exact
    // request shape without exposing either value.
    const safeRequestBody = {
      code: `[REDACTED: ${code.length} characters]`,
      client_id: form.get('client_id'),
      client_secret: `[REDACTED: ${form.get('client_secret')?.length ?? 0} characters]`,
      redirect_uri: form.get('redirect_uri'),
      grant_type: form.get('grant_type'),
    };
    const requestDetails = { method: 'POST', url: tokenUrl, headers: requestHeaders, body: safeRequestBody };
    console.log('\n[UPSTOX TOKEN EXCHANGE REQUEST]');
    console.log(JSON.stringify(requestDetails, null, 2));
    this.logger.log(`Upstox token exchange request: ${JSON.stringify(requestDetails)}`);

    let data: UpstoxToken;
    try {
      const response = await axios.post<UpstoxToken>(tokenUrl, form, {
        headers: requestHeaders,
        timeout: 15_000,
      });
      data = response.data;
      console.log('\n[UPSTOX TOKEN EXCHANGE SUCCESS]');
      console.log(JSON.stringify({ status: response.status, headers: response.headers, data: response.data }, null, 2));
      this.logger.log(`Upstox authorization code exchange succeeded (HTTP ${response.status})`);
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const providerError = {
          axiosMessage: error.message,
          response: {
            status: error.response?.status,
            data: error.response?.data,
            headers: error.response?.headers,
          },
          request: {
            ...requestDetails,
            // Axios may normalize header names or add defaults; include the
            // actual config headers too, while preserving the redacted body.
            axiosHeaders: error.config?.headers,
          },
        };
        console.error('\n[UPSTOX TOKEN EXCHANGE FAILED — EXACT PROVIDER RESPONSE]');
        console.error(JSON.stringify(providerError, null, 2));
        this.logger.error(
          `Upstox token exchange failed: ${JSON.stringify(providerError)}`,
          error.stack,
        );
        if (error.response) {
          // The response data is intentionally included in the exception so the
          // frontend displays the actual Upstox error instead of a generic label.
          throw new UnauthorizedException(
            `Upstox token exchange failed (HTTP ${error.response.status}): ${JSON.stringify(error.response.data)}`,
          );
        }
        throw new BadGatewayException('Unable to reach Upstox while exchanging the authorization code');
      }
      this.logger.error('Unexpected error while exchanging the Upstox authorization code', error instanceof Error ? error.stack : undefined);
      throw new InternalServerErrorException('Could not exchange the Upstox authorization code');
    }
    if (!data.access_token) throw new UnauthorizedException('Upstox did not issue an access token');

    const claims = jwt.decode(data.access_token) as UpstoxClaims | null;
    const upstoxUserId = claims?.user_id || data.user_id;
    if (!upstoxUserId) throw new UnauthorizedException('Upstox token has no user identity');

    try {
      // This makes a connection/schema failure explicit before the upserts.
      await this.prisma.$queryRaw`SELECT 1`;
      this.logger.debug('Prisma connection verified before saving Upstox account');
      const user = await this.prisma.user.upsert({
        where: { upstoxUserId },
        update: { name: claims?.user_name || data.user_name, email: claims?.email || data.email },
        create: { upstoxUserId, name: claims?.user_name || data.user_name, email: claims?.email || data.email },
      });
      this.logger.log(`Upstox user saved: ${user.id}`);
      const encryptedAccessToken = this.encrypt(data.access_token);
      const expiresAt = typeof data.expires_at === 'string' || typeof data.expires_at === 'number' ? new Date(Number(data.expires_at)) : claims?.exp ? new Date(claims.exp * 1000) : null;
      await this.prisma.token.upsert({
        where: { userId: user.id },
        update: { encryptedAccessToken, expiresAt },
        create: { userId: user.id, encryptedAccessToken, expiresAt },
      });
      this.logger.log(`Encrypted Upstox token saved for user: ${user.id}; expiry: ${expiresAt?.toISOString() ?? 'not supplied by Upstox'}`);
      return { user };
    } catch (error) {
      this.logger.error(
        `Failed to save Upstox OAuth data to Prisma: ${JSON.stringify({
          upstoxUserId,
          prismaCode: typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined,
          message: error instanceof Error ? error.message : String(error),
        })}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw new InternalServerErrorException('Upstox authorization succeeded, but the account could not be saved');
    }
  }

  session(userId: string) {
    return jwt.sign({ sub: userId }, this.required('TOKEN_ENCRYPTION_KEY'), { expiresIn: '8h' });
  }

  userFromSession(token: string | undefined) {
    try {
      const claims = jwt.verify(token || '', this.required('TOKEN_ENCRYPTION_KEY')) as { sub: string; exp?: number };
      this.logger.log(`Authenticated session | Session User ID: ${claims.sub} | Session expiry: ${claims.exp ? new Date(claims.exp * 1000).toISOString() : 'none'}`);
      return claims.sub;
    } catch (error) {
      this.logger.warn(`Session authentication failed: ${error instanceof Error ? error.message : String(error)}`);
      throw new UnauthorizedException('Sign in with Upstox');
    }
  }

  async accessToken(userId: string) {
    const token = await this.prisma.token.findUnique({ where: { userId }, include: { user: true } });
    if (!token) {
      this.logger.error(`Upstox token missing | User ID: ${userId} | Reason: no Token record for authenticated session user`);
      throw new UnauthorizedException('Connect your Upstox account first');
    }
    const accessToken = this.decrypt(token.encryptedAccessToken);
    const claims = jwt.decode(accessToken) as UpstoxClaims | null;
    const expiry = token.expiresAt ?? (claims?.exp ? new Date(claims.exp * 1000) : null);
    this.logger.log(`Upstox token check | User ID: ${userId} | Prisma User ID: ${token.userId} | Upstox User ID: ${token.user.upstoxUserId} | Token Found: true | Token Length: ${accessToken.length} | JWT Claims: ${JSON.stringify(claims)} | Token Expiry: ${expiry?.toISOString() ?? 'not present'}`);
    if (token.userId !== userId) this.logger.error(`User mismatch | Authenticated User ID: ${userId} | Prisma User ID: ${token.userId} | Upstox User ID: ${token.user.upstoxUserId}`);
    if (expiry && expiry.getTime() <= Date.now()) throw new UnauthorizedException('Reconnect Upstox: the stored Upstox access token has expired. Upstox OAuth does not issue a refresh token for this flow.');
    return accessToken;
  }

  /**
   * The profile request belongs here because this service owns the authenticated
   * session-to-Upstox-token mapping.  Keeping it here also avoids making the
   * auth module depend on the stocks module just to service /auth/profile.
   */
  async profile(userId: string) {
    const accessToken = await this.accessToken(userId);
    const endpoint = `${API}/user/profile`;
    this.logger.log(`Upstox profile request | User ID: ${userId} | Endpoint: ${endpoint}`);
    try {
      const response = await axios.get(endpoint, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
        timeout: 15_000,
      });
      this.logger.log(`Upstox profile response | User ID: ${userId} | Status: ${response.status}`);
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        this.logger.error(`Upstox profile request failed | User ID: ${userId} | Status: ${error.response?.status ?? 'network'} | Response: ${JSON.stringify(error.response?.data ?? error.message)}`);
        if (error.response?.status === 401) {
          throw new UnauthorizedException('Reconnect Upstox: access token was rejected by Upstox. Upstox authorization-code tokens cannot be refreshed.');
        }
        throw new BadGatewayException(`Upstox profile error (${error.response?.status ?? 'network'}): ${JSON.stringify(error.response?.data ?? error.message)}`);
      }
      throw error;
    }
  }
}
