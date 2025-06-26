import { IsNotEmpty, IsNumber, IsString, IsUUID, Max, Min, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class CreateCommentDto {
    @ApiProperty({ description: 'Message du commentaire' })
    @IsNotEmpty()
    @IsString()
    message: string;

    @ApiProperty({ description: 'Note de 1 à 5', minimum: 1, maximum: 5 })
    @IsNumber()
    @Min(1)
    @Max(5)
    @Type(() => Number)
    rating: number;

    @ApiProperty({ description: 'ID de la commande' })
    @IsNotEmpty()
    @IsUUID()
    order_id: string;
}

export class UpdateCommentDto {
    @ApiProperty({ description: 'Message du commentaire', required: false })
    @IsString()
    @IsOptional()
    message?: string;

    @ApiProperty({ description: 'Note de 1 à 5', minimum: 1, maximum: 5, required: false })
    @IsNumber()
    @IsOptional()
    @Min(1)
    @Max(5)
    @Type(() => Number)
    rating?: number;
}

export class CommentResponseDto {
    @ApiProperty()
    id: string;

    @ApiProperty()
    message: string;

    @ApiProperty()
    rating: number;

    @ApiProperty()
    customer_id: string;

    @ApiProperty()
    order_id: string;

    @ApiProperty()
    created_at: Date;

    @ApiProperty()
    updated_at: Date;

    @ApiProperty({ required: false })
    @IsOptional()
    customer?: {
        id: string;
        first_name?: string;
        last_name?: string;
        phone: string;
        image?: string;
    };

    @ApiProperty({ required: false })
    @IsOptional()
    order?: {
        id: string;
        reference: string;
        created_at: Date;
    };
}

export class DishCommentsResponseDto {
    @ApiProperty()
    dish_id: string;

    @ApiProperty()
    dish_name: string;

    @ApiProperty()
    total_comments: number;

    @ApiProperty()
    average_rating: number;

    @ApiProperty({ type: [CommentResponseDto] })
    comments: CommentResponseDto[];
}

export class GetCommentsQueryDto {
    @ApiProperty({ required: false, default: 1 })
    @IsOptional()
    @IsNumber()
    @Min(1)
    @Type(() => Number)
    page?: number = 1;

    @ApiProperty({ required: false, default: 10 })
    @IsOptional()
    @IsNumber()
    @Min(0)
    @Type(() => Number)
    limit?: number = 10;

    @ApiProperty({ required: false, description: 'Filtrer par note minimum' })
    @IsNumber()
    @IsOptional()
    @Min(1)
    @Max(5)
    @Type(() => Number)
    min_rating?: number;

    @ApiProperty({ required: false, description: 'Filtrer par note maximum' })
    @IsNumber()
    @IsOptional()
    @Min(1)
    @Max(5)
    @Type(() => Number)
    max_rating?: number;

    @ApiProperty({ required: false, description: 'Filtrer par ID de restaurant' })
    @IsOptional()
    @IsUUID()
    restaurantId?: string;
}