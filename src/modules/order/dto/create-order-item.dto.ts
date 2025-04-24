import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsArray, IsNumber, IsOptional, IsUUID, Min } from "class-validator";
import { Transform } from "class-transformer";

export class CreateOrderItemDto {
    @ApiProperty({ description: "ID du plat" })
    @IsUUID()
    dish_id: string;

    @ApiProperty({ description: "Quantité commandée", minimum: 1, default: 1 })
    @IsNumber()
    @Min(1)
    @Transform(({ value }) => Number(value))
    quantity: number;

    @ApiPropertyOptional({ description: "IDs des suppléments choisis", type: [String] })
    @IsOptional()
    @IsArray()
    @IsUUID(undefined, { each: true })
    supplements_ids?: string[];
}