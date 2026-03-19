import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional } from 'class-validator';

export class UpdateUserDto {
  @ApiPropertyOptional({ description: 'Tags à mettre à jour (clé/valeur)' })
  @IsObject()
  @IsOptional()
  tags?: Record<string, string | number | boolean>;

  @ApiPropertyOptional({ description: 'Propriétés utilisateur (language, timezone, etc.)' })
  @IsObject()
  @IsOptional()
  properties?: Record<string, unknown>;
}
