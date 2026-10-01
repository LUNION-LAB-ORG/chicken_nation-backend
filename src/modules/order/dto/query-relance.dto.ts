import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

/**
 * Filtre de restaurant des relances. Ignoré pour un compte de restaurant : il
 * ne voit que le sien (`resolveRestaurantScope`).
 */
export class QueryRelanceDto {
  @ApiPropertyOptional({ description: 'Restaurant à afficher, tous si absent' })
  @IsOptional()
  @IsUUID(undefined, { message: 'Restaurant inconnu.' })
  restaurantId?: string;
}
