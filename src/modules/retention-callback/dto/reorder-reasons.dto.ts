import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsNotEmpty, IsUUID } from 'class-validator';

export class ReorderReasonsDto {
  @ApiProperty({ description: 'Liste ordonnée des IDs de raisons' })
  @IsArray()
  @IsNotEmpty()
  @IsUUID('4', { each: true })
  ids: string[];
}
