import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsObject } from 'class-validator';

export class CreateAliasDto {
  @ApiProperty({
    description: 'Identité / aliases à ajouter (ex: { "phone_number": "+22500000000" })',
    example: { phone_number: '+22500000000' },
  })
  @IsObject()
  @IsNotEmpty()
  identity: Record<string, string>;
}
