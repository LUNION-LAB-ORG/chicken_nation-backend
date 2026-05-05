import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsUUID } from 'class-validator';

export class AssignRestaurantDto {
  @ApiProperty({ description: 'UUID du restaurant à affecter au livreur' })
  @IsNotEmpty()
  @IsUUID()
  restaurant_id: string;
}
