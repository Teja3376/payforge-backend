import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

@Module({
  imports: [
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        // Short access tokens: revocation is handled by refresh-token sessions,
        // so there is no need for a long-lived, unrevocable bearer.
        signOptions: { expiresIn: '1h', issuer: 'payforge', audience: 'payforge-api' },
        verifyOptions: { issuer: 'payforge', audience: 'payforge-api', algorithms: ['HS256'] },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService],
  exports: [JwtModule],
})
export class AuthModule {}
