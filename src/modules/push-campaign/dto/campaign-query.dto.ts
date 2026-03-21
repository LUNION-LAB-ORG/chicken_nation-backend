import { IsOptional, IsString, IsNumberString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class CampaignQueryDto {
  @ApiPropertyOptional({ default: '1' })
  @IsNumberString()
  @IsOptional()
  page?: string;

  @ApiPropertyOptional({ default: '20' })
  @IsNumberString()
  @IsOptional()
  limit?: string;

  @ApiPropertyOptional({ enum: ['draft', 'sent', 'scheduled', 'failed'] })
  @IsString()
  @IsOptional()
  status?: string;

  @ApiPropertyOptional({ description: 'Recherche par nom' })
  @IsString()
  @IsOptional()
  search?: string;
}

export class TemplateQueryDto {
  @ApiPropertyOptional({ default: '1' })
  @IsNumberString()
  @IsOptional()
  page?: string;

  @ApiPropertyOptional({ default: '20' })
  @IsNumberString()
  @IsOptional()
  limit?: string;

  @ApiPropertyOptional({ description: 'Recherche par nom' })
  @IsString()
  @IsOptional()
  search?: string;
}
