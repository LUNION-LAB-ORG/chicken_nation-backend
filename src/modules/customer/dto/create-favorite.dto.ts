import { IsNotEmpty, IsUUID } from 'class-validator';

export class CreateFavoriteDto {
    @IsNotEmpty()
    @IsUUID()
    customer_id: string;

    @IsNotEmpty()
    @IsUUID()
    dish_id: string;
}