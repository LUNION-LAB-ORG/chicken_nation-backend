import { IsString, IsBoolean, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateRestaurantScheduleDto {
  @ApiProperty({ description: 'Jour de la semaine (lundi, mardi, etc.)' })
  @IsString()
  day: string;

  @ApiProperty({ description: 'Heure d\'ouverture' })
  @IsString()
  opening_time: string;

  @ApiProperty({ description: 'Heure de fermeture' })
  @IsString()
  closing_time: string;

  @ApiProperty({ description: 'Indique si le restaurant est fermu00e9 ce jour-lu00e0', default: false })
  @IsBoolean()
  @IsOptional()
  is_closed?: boolean;
}
