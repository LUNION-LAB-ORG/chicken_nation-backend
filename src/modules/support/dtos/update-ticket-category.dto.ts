import { IsOptional, IsString } from "class-validator";

export class UpdateTicketCategoryDto {
    @IsString()
    @IsOptional()
    name?: string;

    @IsString()
    @IsOptional()
    description?: string;
}