import { ApiProperty } from '@nestjs/swagger';
import { AccountStatus, Role } from '@prisma/client';

export class UserProfileDto {
  @ApiProperty({ example: 'PF-USR-D6DC83B1' })
  publicId!: string;

  @ApiProperty({ example: 'user@example.com' })
  email!: string;

  @ApiProperty({ enum: Role, example: Role.USER })
  role!: Role;

  @ApiProperty({ example: 'IN' })
  countryCode!: string;

  @ApiProperty({ enum: AccountStatus, example: AccountStatus.ACTIVE })
  status!: AccountStatus;
}

export class RegisteredMerchantDto {
  @ApiProperty({ example: 'PF-MER-A1B2C3D4' })
  publicId!: string;

  @ApiProperty({ example: 'Northwind Stores' })
  name!: string;

  @ApiProperty({ enum: AccountStatus, example: AccountStatus.ACTIVE })
  status!: AccountStatus;
}

export class RegisterMerchantResponseDto extends UserProfileDto {
  @ApiProperty({ type: RegisteredMerchantDto })
  merchant!: RegisteredMerchantDto;
}

export class LoginUserDto extends UserProfileDto {
  @ApiProperty({ example: 'PF-MER-A1B2C3D4', nullable: true })
  merchantPublicId!: string | null;
}

export class LoginResponseDto {
  @ApiProperty({ description: 'Send this value as Authorization: Bearer <accessToken>.' })
  accessToken!: string;

  @ApiProperty({ type: LoginUserDto })
  user!: LoginUserDto;
}
