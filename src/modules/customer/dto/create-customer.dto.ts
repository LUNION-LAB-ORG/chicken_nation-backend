import { IsString, IsOptional, IsEmail, IsPhoneNumber, IsDateString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';

export class CreateCustomerDto {
    @ApiProperty({ description: 'Numéro de téléphone du client', example: '+225070707070' })
    @IsPhoneNumber("CI", { message: 'Numéro de téléphone non valide, utilisez le format +225' })
    @IsString()
    @Transform(({ value }) => value.trim())
    phone: string;

    @ApiPropertyOptional({ description: 'Prénom du client', example: 'John' })
    @IsString()
    @IsOptional()
    @Transform(({ value }) => value.trim())
    first_name?: string;

    @ApiPropertyOptional({ description: 'Nom du client', example: 'Doe' })
    @IsString()
    @IsOptional()
    @Transform(({ value }) => value.trim())
    last_name?: string;

    @ApiPropertyOptional({ description: 'Date de naissance du client', example: '1990-01-01' })
    @IsDateString()
    @IsOptional()
    @Transform(({ value }) => value.trim())
    birth_day?: string;

    @ApiPropertyOptional({ description: 'Email du client', example: 'john.doe@example.com' })
    @IsEmail({}, { message: 'Email non valide' })
    @IsOptional()
    @Transform(({ value }) => value.trim())
    email?: string;

    @ApiPropertyOptional({ description: 'Image du profil du client', example: 'https://example.com/image.jpg' })
    @IsString()
    @IsOptional()
    @Transform(({ value }) => value.trim())
    image?: string;
}
