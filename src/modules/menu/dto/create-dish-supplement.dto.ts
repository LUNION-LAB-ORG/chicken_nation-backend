import { IsNotEmpty, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateDishSupplementDto {
  @ApiProperty({ description: 'ID du plat' })
  @IsNotEmpty()
  @IsUUID()
  dish_id: string;

  @ApiProperty({ description: 'ID du supplément' })
  @IsNotEmpty()
  @IsUUID()
  supplement_id: string;
}