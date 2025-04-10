import { PartialType } from '@nestjs/swagger';
import { CreateUserDto } from 'src/users/dto/create-user.dto';
import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, MaxLength, Matches } from 'class-validator';
import { Transform } from 'class-transformer';

export class UpdateUserDto extends PartialType(CreateUserDto) {
  // CONFIRM PASSWORD
  @ApiProperty({
    description: "la confirmation du mot de passe de l'utilisateur",
    example: 'Password01@',
    required: false,
    maxLength: 100,
  })
  @IsOptional()
  @MaxLength(100)
  @Transform(({ value }) => value?.trim())
  @Matches(/^(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/, {
    message:
      'La confirmation du mot de passe doit contenir au moins 8 caractères, une majuscule, un chiffre et un caractère spécial.',
  })
  confirmPassword: string;
}
