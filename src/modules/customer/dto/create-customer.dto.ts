import { IsString, IsOptional, IsEmail, IsPhoneNumber, IsDateString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { parse, isValid } from 'date-fns';

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
    @IsDateString({}, { message: 'La date de naissance doit être au format JJ/MM/AAAA' })
    @IsOptional()
    @Transform(({ value }) => {
        const parsedDate = parse(value, 'dd/MM/yyyy', new Date());
        if (isValid(parsedDate)) {
            return parsedDate.toISOString();
        }
        return value;
    })
    birth_day?: string;

    @ApiPropertyOptional({ description: 'Email du client', example: 'john.doe@example.com' })
    @IsEmail({}, { message: 'Email non valide' })
    @IsOptional()
    @Transform(({ value }) => value.trim())
    email?: string;

    @ApiPropertyOptional({ description: 'Image du profil du client', type: "file" as "string" })
    @IsString()
    @IsOptional()
    image?: string;
}

