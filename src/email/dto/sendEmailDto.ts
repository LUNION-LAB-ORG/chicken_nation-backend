import { IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class sendEmailDto {
  @ApiProperty({
    description: 'Liste des destinataires',
    type: [String],
    required: true,
  })
  @IsNotEmpty()
  @IsEmail({}, { each: true })
  recipients: string | string[];

  @ApiProperty({
    description: 'Sujet du mail',
    type: String,
    required: true,
  })
  @IsString()
  subject: string;

  @ApiProperty({
    description: 'Contenu HTML du mail',
    type: String,
    required: true,
  })
  @IsString()
  html: string;

  @ApiPropertyOptional({
    description: 'Contenu textuel du mail',
    type: String,
    required: false,
  })
  @IsOptional()
  @IsString()
  text?: string;
}
