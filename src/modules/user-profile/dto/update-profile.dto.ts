import { IsString, IsEmail, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateProfileDto {
  @ApiProperty({ description: 'Prénom de l\'utilisateur', required: false })
  @IsString()
  @IsOptional()
  first_name?: string;

  @ApiProperty({ description: 'Nom de l\'utilisateur', required: false })
  @IsString()
  @IsOptional()
  last_name?: string;

  @ApiProperty({ description: 'Nom d\'utilisateur', required: false })
  @IsString()
  @IsOptional()
  username?: string;

  @ApiProperty({ description: 'Adresse email', required: false })
  @IsEmail()
  @IsOptional()
  email?: string;

  @ApiProperty({ description: 'Numéro de téléphone', required: false })
  @IsString()
  @IsOptional()
  phone_number?: string;

  @ApiProperty({ description: 'Photo de profil (URL)', required: false })
  @IsString()
  @IsOptional()
  profile_picture?: string;
}
