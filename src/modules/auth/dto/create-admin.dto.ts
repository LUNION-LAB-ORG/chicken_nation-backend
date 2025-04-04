import { IsEmail, IsNotEmpty, IsString, IsOptional, IsBoolean } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateAdminDto {
  @ApiProperty({ description: 'Prénom de l\'administrateur' })
  @IsString()
  @IsNotEmpty()
  first_name: string;

  @ApiProperty({ description: 'Nom de l\'administrateur' })
  @IsString()
  @IsNotEmpty()
  last_name: string;

  @ApiProperty({ description: 'Nom d\'utilisateur unique' })
  @IsString()
  @IsNotEmpty()
  username: string;

  @ApiProperty({ description: 'Email de l\'administrateur' })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({ description: 'Mot de passe de l\'administrateur' })
  @IsString()
  @IsNotEmpty()
  password: string;

  @ApiProperty({ description: 'Numéro de téléphone', required: false })
  @IsString()
  @IsOptional()
  phone_number?: string;

  @ApiProperty({ description: 'Type de rôle (admin ou manager)', enum: ['admin', 'manager'] })
  @IsString()
  @IsNotEmpty()
  role_type: 'admin' | 'manager';
}
