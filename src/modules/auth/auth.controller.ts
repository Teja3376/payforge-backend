import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { RateLimit } from '../../common/config/rate-limits';
import {
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { ApiErrorDto } from '../../common/swagger/api-error.dto';
import { Authenticated } from '../../common/decorators/roles.decorator';
import { ChangePasswordDto } from './dto/change-password.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import type { RequestUser } from '../../common/auth/request-user';
import { isPublicId } from '../../common/utils/generate-public-id';
import { ApiError, ErrorCode } from '../../common/errors/api-error';
import { AuthService } from './auth.service';
import { LoginResponseDto, RegisterMerchantResponseDto, UserProfileDto } from './dto/auth-response.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { RegisterMerchantDto } from './dto/register-merchant.dto';
import { RegisterUserDto } from './dto/register-user.dto';
import { SessionResponseDto } from './dto/session-response.dto';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle({ auth: RateLimit.register })
  @Post('register/user')
  @ApiOperation({ summary: 'Register a customer' })
  @ApiCreatedResponse({ type: UserProfileDto })
  @ApiBadRequestResponse({ type: ApiErrorDto })
  @ApiTooManyRequestsResponse({ type: ApiErrorDto })
  registerUser(@Body() dto: RegisterUserDto) {
    return this.auth.registerUser(dto);
  }

  @Public()
  @Throttle({ auth: RateLimit.register })
  @Post('register/merchant')
  @ApiOperation({
    summary: 'Register a merchant',
    description:
      'The merchant starts in PENDING_REVIEW and cannot receive payments until an administrator approves it.',
  })
  @ApiCreatedResponse({ type: RegisterMerchantResponseDto })
  @ApiBadRequestResponse({ type: ApiErrorDto })
  @ApiTooManyRequestsResponse({ type: ApiErrorDto })
  registerMerchant(@Body() dto: RegisterMerchantDto) {
    return this.auth.registerMerchant(dto);
  }

  /**
   * Tightest limit in the API: this is the credential-stuffing surface, and
   * every attempt also costs a bcrypt comparison of CPU.
   */
  @Public()
  @Throttle({ auth: RateLimit.auth })
  @HttpCode(200)
  @Post('login')
  @ApiOperation({
    summary: 'Sign in',
    description:
      'Returns a short-lived access token (1h) and a rotating refresh token (30d). Repeated failures lock the account for 15 minutes.',
  })
  @ApiOkResponse({ type: LoginResponseDto })
  @ApiBadRequestResponse({ type: ApiErrorDto })
  @ApiUnauthorizedResponse({ type: ApiErrorDto })
  @ApiTooManyRequestsResponse({ type: ApiErrorDto, description: 'Account temporarily locked.' })
  login(@Body() dto: LoginDto, @Req() request: Request) {
    return this.auth.login(dto, {
      ip: clientIp(request),
      userAgent: request.headers['user-agent']?.slice(0, 255),
    });
  }

  @Public()
  @Throttle({ auth: RateLimit.refresh })
  @HttpCode(200)
  @Post('refresh')
  @ApiOperation({
    summary: 'Exchange a refresh token for a new access token',
    description: 'The presented refresh token is rotated and cannot be reused.',
  })
  @ApiOkResponse({ type: LoginResponseDto })
  @ApiUnauthorizedResponse({ type: ApiErrorDto })
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @Post('logout')
  @HttpCode(204)
  @Authenticated()
  @ApiOperation({
    summary: 'Revoke the current session',
    description:
      'The session is taken from the validated `sid` claim rather than a request header. ' +
      'Omitting it is no longer possible by accident, so this cannot be widened into ' +
      'revoking every session by sending no header.',
  })
  @ApiUnauthorizedResponse({ type: ApiErrorDto })
  logout(@CurrentUser() user: RequestUser) {
    return this.auth.logout(user.sessionId, user.id);
  }

  @Post('password')
  @HttpCode(200)
  @Authenticated()
  @ApiOperation({
    summary: 'Change your password',
    description:
      'Requires the current password. Every other session is revoked; the session making ' +
      'the change stays active.',
  })
  @ApiBadRequestResponse({ type: ApiErrorDto })
  @ApiUnauthorizedResponse({ type: ApiErrorDto })
  changePassword(@CurrentUser() user: RequestUser, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(user.id, dto.currentPassword, dto.newPassword, user.sessionId);
  }

  @Get('sessions')
  @Authenticated()
  @ApiOperation({ summary: 'List your active sessions' })
  @ApiOkResponse({ type: SessionResponseDto, isArray: true })
  sessions(@CurrentUser() user: RequestUser) {
    return this.auth.listSessions(user.id);
  }

  @Delete('sessions/:publicId')
  @Authenticated()
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke one session' })
  revoke(@CurrentUser() user: RequestUser, @Param('publicId') publicId: string) {
    if (!isPublicId(publicId)) {
      throw ApiError.of(ErrorCode.VALIDATION_FAILED, 'That session id is not valid.');
    }
    return this.auth.revokeSession(user.id, publicId);
  }
}

function clientIp(request: Request): string | undefined {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return request.ip ?? undefined;
}