import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class RefreshDto {
  @ApiProperty({ description: 'The refreshToken returned by POST /auth/login.' })
  @IsString()
  @MinLength(20, { message: 'Enter the refresh token you were given.' })
  refreshToken!: string;
}
