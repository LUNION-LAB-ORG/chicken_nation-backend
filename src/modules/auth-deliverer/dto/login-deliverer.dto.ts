import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, Length, Matches, MaxLength } from 'class-validator';

import { normaliserTelephoneSaisi } from './telephone.transform';

export class LoginDelivererDto {
  @ApiProperty({ example: '+2250777777777' })
  @IsNotEmpty()
  @MaxLength(20)
  @Transform(normaliserTelephoneSaisi)
  phone: string;

  @ApiProperty({ description: 'Code à 4 chiffres', example: '1234' })
  @IsNotEmpty()
  @Length(4, 4)
  @Matches(/^\d{4}$/, { message: 'Le mot de passe doit contenir exactement 4 chiffres' })
  password: string;
}
