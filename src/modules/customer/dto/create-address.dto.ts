import { IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID } from 'class-validator';
import { Transform } from 'class-transformer';

export class CreateAddressDto {
  @IsNotEmpty()
  @IsString()
  @Transform(({ value }) => value.toString())
  title: string;

  @IsNotEmpty()
  @IsString()
  @Transform(({ value }) => value.toString())
  address: string;

  @IsOptional()
  @IsString()
  @Transform(({ value }) => value.toString())
  street?: string;

  @IsOptional()
  @IsString()
  @Transform(({ value }) => value.toString())
  city?: string;

  @IsNotEmpty()
  @IsNumber()
  longitude: number;

  @IsNotEmpty()
  @IsNumber()
  latitude: number;

  @IsOptional()
  @IsUUID()
  customer_id?: string;
}