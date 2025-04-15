import { IsNotEmpty, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateFavoriteDto {
    @ApiProperty({ description: 'ID du plat' })
    @IsNotEmpty()
    @IsUUID()
    dish_id: string;
}