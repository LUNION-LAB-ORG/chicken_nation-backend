import { IsEnum, IsOptional, IsString, IsUUID, ValidateNested } from 'class-validator';
import { ActivityType } from '../entities/user-activity.entity';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class TrackActivityDto {
  @ApiProperty({
    enum: ActivityType,
    description: 'Type of user activity',
    example: ActivityType.VIEW_PRODUCT,
  })
  @IsEnum(ActivityType)
  activityType: ActivityType;

  @ApiProperty({
    description: 'ID of the resource related to the activity (product, order, etc.)',
    example: '123e4567-e89b-12d3-a456-426614174000',
    required: false,
  })
  @IsOptional()
  @IsUUID()
  resourceId?: string;

  @ApiProperty({
    description: 'Additional metadata about the activity',
    example: { searchQuery: 'pizza', filters: { category: 'Italian' } },
    required: false,
  })
  @IsOptional()
  metadata?: Record<string, any>;
}
