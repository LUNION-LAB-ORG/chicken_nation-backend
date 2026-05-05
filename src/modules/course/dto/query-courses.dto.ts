import { ApiProperty } from '@nestjs/swagger';
import { CourseStatut } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

/** Filtres pour la liste des courses (admin + livreur history) */
export class QueryCoursesDto {
  @ApiProperty({ required: false, enum: CourseStatut })
  @IsOptional()
  @IsEnum(CourseStatut)
  statut?: CourseStatut;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  restaurant_id?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  deliverer_id?: string;

  @ApiProperty({ required: false, description: 'Recherche par référence ou code retrait' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiProperty({ required: false, description: 'Date ISO de début' })
  @IsOptional()
  @IsString()
  startDate?: string;

  @ApiProperty({ required: false, description: 'Date ISO de fin' })
  @IsOptional()
  @IsString()
  endDate?: string;

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
