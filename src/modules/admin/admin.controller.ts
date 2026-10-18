import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiConflictResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiParam, ApiTags, ApiUnauthorizedResponse, ApiForbiddenResponse } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import type { RequestUser } from '../../common/auth/request-user';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ApiErrorDto } from '../../common/swagger/api-error.dto';
import { AdminService } from './admin.service';
import { AccountActionDto, AdminOverviewDto, FeeEntryDto, RefundResultDto } from './dto/admin-response.dto';

@ApiTags('Admin')
@ApiBearerAuth('access-token')
@ApiUnauthorizedResponse({ type: ApiErrorDto })
@ApiForbiddenResponse({ type: ApiErrorDto, description: 'Only an administrator can use these actions.' })
@Controller('admin')
@Roles(Role.SUPER_ADMIN)
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('overview')
  @ApiOperation({ summary: 'Platform fees and each merchant average per month' })
  @ApiOkResponse({ type: AdminOverviewDto })
  overview() {
    return this.admin.overview();
  }

  @Get('fees')
  @ApiOperation({ summary: 'Recent platform fee ledger entries' })
  @ApiOkResponse({ type: FeeEntryDto, isArray: true })
  fees() {
    return this.admin.fees();
  }

  @Post('merchants/:publicId/suspend')
  @HttpCode(200)
  @ApiOperation({ summary: 'Suspend a merchant' })
  @ApiParam({ name: 'publicId', example: 'PF-MER-A1B2C3D4' })
  @ApiOkResponse({ type: AccountActionDto })
  @ApiNotFoundResponse({ type: ApiErrorDto })
  @ApiConflictResponse({ type: ApiErrorDto })
  suspendMerchant(@CurrentUser() user: RequestUser, @Param('publicId') publicId: string) {
    return this.admin.suspendMerchant(user.id, publicId);
  }

  @Post('merchants/:publicId/restore')
  @HttpCode(200)
  @ApiOperation({ summary: 'Restore a suspended merchant' })
  @ApiParam({ name: 'publicId', example: 'PF-MER-A1B2C3D4' })
  @ApiOkResponse({ type: AccountActionDto })
  @ApiNotFoundResponse({ type: ApiErrorDto })
  @ApiConflictResponse({ type: ApiErrorDto })
  restoreMerchant(@CurrentUser() user: RequestUser, @Param('publicId') publicId: string) {
    return this.admin.restoreMerchant(user.id, publicId);
  }

  @Post('users/:publicId/suspend')
  @HttpCode(200)
  @ApiOperation({ summary: 'Suspend a user' })
  @ApiParam({ name: 'publicId', example: 'PF-USR-D6DC83B1' })
  @ApiOkResponse({ type: AccountActionDto })
  @ApiNotFoundResponse({ type: ApiErrorDto })
  @ApiConflictResponse({ type: ApiErrorDto })
  suspendUser(@CurrentUser() user: RequestUser, @Param('publicId') publicId: string) {
    return this.admin.suspendUser(user.id, publicId);
  }

  @Post('users/:publicId/restore')
  @HttpCode(200)
  @ApiOperation({ summary: 'Restore a suspended user' })
  @ApiParam({ name: 'publicId', example: 'PF-USR-D6DC83B1' })
  @ApiOkResponse({ type: AccountActionDto })
  @ApiNotFoundResponse({ type: ApiErrorDto })
  @ApiConflictResponse({ type: ApiErrorDto })
  restoreUser(@CurrentUser() user: RequestUser, @Param('publicId') publicId: string) {
    return this.admin.restoreUser(user.id, publicId);
  }

  @Post('payments/:publicId/refund')
  @HttpCode(200)
  @ApiOperation({ summary: 'Refund a successful payment' })
  @ApiParam({ name: 'publicId', example: 'PF-PAY-A1B2C3D4' })
  @ApiOkResponse({ type: RefundResultDto })
  @ApiNotFoundResponse({ type: ApiErrorDto })
  @ApiConflictResponse({ type: ApiErrorDto })
  refund(@CurrentUser() user: RequestUser, @Param('publicId') publicId: string) {
    return this.admin.refund(user.id, publicId);
  }
}
