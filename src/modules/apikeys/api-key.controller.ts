import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Role } from '@prisma/client';
import type { RequestUser } from '../../common/auth/request-user';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Authenticated, Roles } from '../../common/decorators/roles.decorator';
import { Scopes } from '../../common/decorators/scopes.decorator';
import { ALL_SCOPES, Scope } from '../../common/scopes/scopes';
import { ApiErrorDto } from '../../common/swagger/api-error.dto';
import { assertPublicId } from '../payments/payment.controller';
import { ApiKeyResponseDto, CreatedApiKeyDto, CreateApiKeyDto } from './dto/api-key.dto';
import { ApiKeyService } from './api-key.service';

@ApiTags('API Keys')
@ApiOkResponse({ type: ApiKeyResponseDto, isArray: true })
@Controller('api-keys')
export class ApiKeyController {
  constructor(private readonly keys: ApiKeyService) {}

  @Post()
  @Roles(Role.MERCHANT, Role.SUPER_ADMIN)
  @Scopes(Scope.API_KEYS_MANAGE)
  @Authenticated()
  @ApiOperation({
    summary: 'Create an API key',
    description:
      'The key is shown once and cannot be retrieved later — only a prefix is stored. Scope it to the minimum the integration needs and issue separate read and write keys.',
  })
  @ApiCreatedResponse({ type: CreatedApiKeyDto })
  @ApiBadRequestResponse({ type: ApiErrorDto })
  @ApiForbiddenResponse({ type: ApiErrorDto, description: 'API key is missing the apikeys:manage scope.' })
  @ApiUnauthorizedResponse({ type: ApiErrorDto })
  create(@CurrentUser() user: RequestUser, @Body() dto: CreateApiKeyDto) {
    return this.keys.create(
      {
        merchantId: user.merchantId!,
        name: dto.name,
        scopes: dto.scopes,
        mode: dto.mode,
        expiresInDays: dto.expiresInDays,
      },
      user.id,
    );
  }

  @Get()
  @Roles(Role.MERCHANT, Role.SUPER_ADMIN)
  @Scopes(Scope.API_KEYS_MANAGE)
  @Authenticated()
  @ApiOperation({
    summary: 'List API keys',
    description: 'Secrets are never returned. Only the lookup prefix is shown.',
  })
  @ApiOkResponse({ type: ApiKeyResponseDto, isArray: true })
  list(@CurrentUser() user: RequestUser) {
    return this.keys.list(user.merchantId!);
  }

  @Post(':publicId/revoke')
  @Roles(Role.MERCHANT, Role.SUPER_ADMIN)
  @Scopes(Scope.API_KEYS_MANAGE)
  @Authenticated()
  @ApiOperation({
    summary: 'Revoke an API key',
    description: 'Takes effect immediately. Any in-flight request using this key completes normally.',
  })
  @ApiParam({ name: 'publicId', example: 'PF-KEY-A1B2C3D4E5F6' })
  @ApiOkResponse({ type: ApiKeyResponseDto })
  @ApiNotFoundResponse({ type: ApiErrorDto })
  revoke(@CurrentUser() user: RequestUser, @Param('publicId') publicId: string) {
    return this.keys.revoke(user.merchantId!, assertPublicId(publicId), user.id);
  }

  @Get('scopes')
  @Roles(Role.MERCHANT, Role.SUPER_ADMIN)
  @Authenticated()
  @ApiOperation({ summary: 'List every scope available to an API key' })
  @ApiOkResponse({ type: [String] })
  scopes(): string[] {
    return [...ALL_SCOPES];
  }
}