import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * Password policy.
 *
 * `Users.passwordChangedAt` existed but was never read and there was no
 * endpoint, so a merchant whose password leaked had no way to rotate it.
 */
export class ChangePasswordDto {
  @ApiProperty({ example: 'the current password' })
  @IsString()
  @MaxLength(200)
  currentPassword!: string;

  @ApiProperty({
    example: 'a-new-strong-passphrase',
    minLength: 12,
    description:
      'At least 12 characters. Length is the dominant factor in password strength, ' +
      'and the bootstrap admin secret is held to the same floor.',
  })
  @IsString()
  @MinLength(12, { message: 'Use at least 12 characters for your password.' })
  @MaxLength(200)
  @Matches(/^\S/, { message: 'A password cannot begin with a space.' })
  newPassword!: string;
}