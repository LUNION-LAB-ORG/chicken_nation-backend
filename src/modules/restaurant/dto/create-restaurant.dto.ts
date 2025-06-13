import { IsEmail, IsNotEmpty, IsOptional, IsString, IsNumber } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';

export class CreateRestaurantDto {
    @ApiProperty({ description: 'Restaurant name' })
    @IsNotEmpty()
    @IsString()
    name: string;

    @ApiPropertyOptional({ description: 'Restaurant description' })
    @IsOptional()
    @IsString()
    description?: string;

    @ApiPropertyOptional({ description: 'Restaurant image', type:"file" as "string" })
    @IsOptional()
    @IsString()
    image?: string;

    @ApiPropertyOptional({ description: 'Restaurant address' })
    @IsOptional()
    @IsString()
    address?: string;

    @ApiPropertyOptional({ description: 'Restaurant latitude' })
    @IsOptional()
    @IsNumber()
    @Transform(({ value }) => Number(value))
    latitude?: number;

    @ApiPropertyOptional({ description: 'Restaurant longitude' })
    @IsOptional()
    @IsNumber()
    @Transform(({ value }) => Number(value))
    longitude?: number;

    @ApiPropertyOptional({ description: 'Restaurant phone', example: '+225070707070' })
    @IsOptional()
    @IsString()
    phone?: string;

    @ApiPropertyOptional({ description: 'Restaurant email' })
    @IsOptional()
    @IsEmail()
    email?: string;

    @ApiPropertyOptional({ description: 'Restaurant schedule' })
    @IsOptional()
    schedule?: Record<string, string>;

    // Manager information
    @ApiProperty({ description: 'Manager fullname' })
    @IsNotEmpty()
    @IsString()
    managerFullname: string;

    @ApiProperty({ description: 'Manager email' })
    @IsNotEmpty()
    @IsEmail()
    managerEmail: string;

    @ApiProperty({ description: 'Manager phone', example: '+225070707070' })
    @IsNotEmpty()
    @IsString()
    managerPhone: string;
}