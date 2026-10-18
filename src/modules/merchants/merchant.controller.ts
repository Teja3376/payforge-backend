import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiForbiddenResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiParam, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import type { RequestUser } from '../../common/auth/request-user';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ApiErrorDto } from '../../common/swagger/api-error.dto';
import { MerchantResponseDto } from './dto/merchant-response.dto';
import { MerchantService } from './merchant.service';

@ApiTags('Merchants')
@ApiBearerAuth('access-token')
@ApiUnauthorizedResponse({ type: ApiErrorDto })
@ApiForbiddenResponse({ type: ApiErrorDto })
@Controller('merchants')
export class MerchantController {
  constructor(private readonly merchants: MerchantService) {}

  @Get('me')
  @Roles(Role.MERCHANT)
  @ApiOperation({ summary: 'Get the signed-in merchant profile and balances' })
  @ApiOkResponse({ type: MerchantResponseDto })
  @ApiNotFoundResponse({ type: ApiErrorDto })
  me(@CurrentUser() user: RequestUser) {
    return this.merchants.getMe(user);
  }

  @Get(':publicId')
  @Roles(Role.MERCHANT, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get a merchant. A merchant can only open their own record.' })
  @ApiParam({ name: 'publicId', example: 'PF-MER-A1B2C3D4' })
  @ApiOkResponse({ type: MerchantResponseDto })
  @ApiNotFoundResponse({ type: ApiErrorDto })
  get(@CurrentUser() user: RequestUser, @Param('publicId') publicId: string) {
    return this.merchants.getMerchant(user, publicId);
  }
}
