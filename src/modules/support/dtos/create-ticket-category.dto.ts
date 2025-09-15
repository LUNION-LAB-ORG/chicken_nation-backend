import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateTicketCategoryDto {
    @IsString()
    @IsNotEmpty()
    name: string;

    @IsString()
    @IsOptional()
    description?: string;
}