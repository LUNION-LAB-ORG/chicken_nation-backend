import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsNumber, IsOptional, IsString, IsUUID } from "class-validator";
import { Transform } from "class-transformer";

export class FraisLivraisonDto {
    @ApiProperty({ description: "Latitude" })
    @IsNumber()
    @Transform(({ value }) => Number(value))
    lat: number;

    @ApiProperty({ description: "Longitude" })
    @IsNumber()
    @Transform(({ value }) => Number(value))
    long: number;

    @ApiPropertyOptional()
    @IsUUID()
    @IsOptional()
    restaurant_id?: string;
}