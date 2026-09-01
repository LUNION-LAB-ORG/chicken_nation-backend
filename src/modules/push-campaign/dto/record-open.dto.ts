import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';

export class RecordOpenDto {
  @ApiProperty({ description: 'Campagne dont la notification a été ouverte' })
  @IsUUID(undefined, { message: "L'identifiant de campagne doit être un UUID valide" })
  campaign_id: string;

  @ApiPropertyOptional({ description: 'Plateforme du téléphone' })
  @IsIn(['ios', 'android'], { message: 'Plateforme inconnue' })
  @IsOptional()
  platform?: string;
}
