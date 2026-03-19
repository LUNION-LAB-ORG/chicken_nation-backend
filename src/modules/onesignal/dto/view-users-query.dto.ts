import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsNumberString } from 'class-validator';

export class ViewUsersQueryDto {
  @ApiPropertyOptional({ description: 'Page (défaut: 1)' })
  @IsNumberString()
  @IsOptional()
  page?: string;

  @ApiPropertyOptional({ description: 'Limite par page (défaut: 20)' })
  @IsNumberString()
  @IsOptional()
  limit?: string;

  @ApiPropertyOptional({ description: 'Recherche par nom ou téléphone' })
  @IsString()
  @IsOptional()
  search?: string;
}
