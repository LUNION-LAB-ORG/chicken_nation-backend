import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsNumber, IsOptional, Min } from "class-validator";

export class QueryTicketsDto {
    @ApiProperty({ required: false, default: 1 })
    @IsOptional() @IsNumber()
    @Min(1) @Type(() => Number)
    page?: number = 1;

    @ApiProperty({ required: false, default: 10 })
    @IsOptional()
    @IsNumber() @Min(0)
    @Type(() => Number)
    limit?: number = 10;
}