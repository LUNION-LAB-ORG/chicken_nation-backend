import { ApiProperty } from '@nestjs/swagger';
import { DelivererStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

export class QueryDeliverersDto {
  @ApiProperty({ required: false, enum: DelivererStatus })
  @IsOptional()
  @IsEnum(DelivererStatus)
  status?: DelivererStatus;

  @ApiProperty({ required: false, description: 'Filtrer par restaurant affecté' })
  @IsOptional()
  @IsUUID()
  restaurant_id?: string;

  @ApiProperty({ required: false, description: 'Recherche sur nom, prénom, email ou téléphone' })
  @IsOptional()
  @IsString()
  @Transform(({ value }) => value?.trim())
  search?: string;

  @ApiProperty({ required: false, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiProperty({ required: false, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}
