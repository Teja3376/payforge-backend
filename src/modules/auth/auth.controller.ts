import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiBadRequestResponse, ApiConflictResponse, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { ApiErrorDto } from '../../common/swagger/api-error.dto';
import { Public } from '../../common/decorators/public.decorator';
import { AuthService } from './auth.service';
import { LoginResponseDto, RegisterMerchantResponseDto, UserProfileDto } from './dto/auth-response.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterMerchantDto } from './dto/register-merchant.dto';
import { RegisterUserDto } from './dto/register-user.dto';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('register/user')
  @ApiOperation({ summary: 'Register a customer' })
  @ApiCreatedResponse({ type: UserProfileDto })
  @ApiBadRequestResponse({ type: ApiErrorDto })
  @ApiConflictResponse({ type: ApiErrorDto, description: 'Email is already registered.' })
  registerUser(@Body() dto: RegisterUserDto) {
    return this.auth.registerUser(dto);
  }

  @Public()
  @Post('register/merchant')
  @ApiOperation({ summary: 'Register a merchant. The merchant can receive payments immediately.' })
  @ApiCreatedResponse({ type: RegisterMerchantResponseDto })
  @ApiBadRequestResponse({ type: ApiErrorDto })
  @ApiConflictResponse({ type: ApiErrorDto, description: 'Email is already registered.' })
  registerMerchant(@Body() dto: RegisterMerchantDto) {
    return this.auth.registerMerchant(dto);
  }

  @Public()
  @HttpCode(200)
  @Post('login')
  @ApiOperation({ summary: 'Sign in and receive a bearer token' })
  @ApiOkResponse({ type: LoginResponseDto })
  @ApiBadRequestResponse({ type: ApiErrorDto })
  @ApiUnauthorizedResponse({ type: ApiErrorDto, description: 'Email or password is incorrect.' })
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }
}
