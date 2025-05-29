import { IsString, IsEnum, IsNumber, IsOptional, IsUUID } from 'class-validator';
import { LoyaltyPointType } from '@prisma/client';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';

export class AddLoyaltyPointDto {
  @ApiProperty({ description: 'ID du client', example: '123' })
  @IsUUID()
  customer_id: string;

  @ApiProperty({ description: 'Points', example: 10 })
  @IsNumber()
  @Transform(({ value }) => Number(value))
  points: number;

  @ApiProperty({ description: 'Type de points', example: 'EARNED' })
  @IsEnum(LoyaltyPointType)
  type: LoyaltyPointType;

  @ApiProperty({ description: 'Raison', example: 'Commande' })
  @IsOptional()
  @IsString()
  reason?: string;

  @ApiPropertyOptional({ description: 'ID de la commande', example: '123' })
  @IsOptional()
  @IsUUID()
  order_id?: string
}