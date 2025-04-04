import { IsArray, IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { OrderStatus, PaymentMethod } from '../entities/order.entity';

export class CreateOrderItemDto {
  @IsString()
  @IsNotEmpty()
  product_id: string;

  @IsNumber()
  @IsNotEmpty()
  quantity: number;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  supplement_ids?: string[];
}

export class CreateOrderDto {
  

  @IsString()
  @IsOptional()
  restaurant_id?: string;

  @IsEnum(PaymentMethod)
  @IsNotEmpty()
  payment_method: PaymentMethod;

  @IsString()
  @IsOptional()
  delivery_address?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItemDto)
  @IsNotEmpty()
  items: CreateOrderItemDto[];
}