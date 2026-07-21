import { CacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { HealthController } from './health.controller';
import { PrismaModule } from './prisma.module';
import { StocksModule } from './stocks/stocks.module';
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', 'apps/api/.env'] }),
    CacheModule.register({ isGlobal: true, ttl: 30_000 }),
    PrismaModule,
    AuthModule,
    StocksModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
