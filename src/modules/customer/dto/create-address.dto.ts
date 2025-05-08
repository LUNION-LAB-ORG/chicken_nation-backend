import { IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateAddressDto {
  @ApiProperty({ description: 'Address title' })
  @IsNotEmpty()
  @IsString()
  @Transform(({ value }) => String(value).trim())
  title: string;

  @ApiProperty({ description: 'Address' })
  @IsNotEmpty()
  @IsString()
  @Transform(({ value }) => String(value).trim())
  address: string;

  @ApiPropertyOptional({ description: 'Street' })
  @IsOptional()
  @IsString()
  @Transform(({ value }) => String(value).trim())
  street?: string;

  @ApiPropertyOptional({ description: 'City' })
  @IsOptional()
  @IsString()
  @Transform(({ value }) => String(value).trim())
  city?: string;

  @ApiProperty({ description: 'Longitude' })
  @IsNotEmpty()
  @IsNumber()
  @Transform(({ value }) => Number(value))
  longitude: number;

  @ApiProperty({ description: 'Latitude' })
  @IsNotEmpty()
  @IsNumber()
  @Transform(({ value }) => Number(value))
  latitude: number;
}