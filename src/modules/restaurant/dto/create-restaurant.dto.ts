import { IsEmail, IsNotEmpty, IsOptional, IsString, IsNumber } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateRestaurantDto {
    @ApiProperty({ description: 'Restaurant name' })
    @IsNotEmpty()
    @IsString()
    name: string;

    @ApiPropertyOptional({ description: 'Restaurant description' })
    @IsOptional()
    @IsString()
    description?: string;

    @ApiPropertyOptional({ description: 'Restaurant image' })
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
    latitude?: number;

    @ApiPropertyOptional({ description: 'Restaurant longitude' })
    @IsOptional()
    @IsNumber()
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
    schedule?: Record<string, any>;

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