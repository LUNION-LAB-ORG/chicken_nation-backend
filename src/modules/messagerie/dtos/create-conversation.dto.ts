import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { CreateOrderItemDto } from 'src/modules/order/dto/create-order-item.dto';
import { OrderType } from 'src/modules/order/enums/order-type.enum';
import { TypeTable } from 'src/modules/order/enums/order-type-table.enum';
import { parse, isValid } from 'date-fns';

export class CreateConversationDto {
  @ApiPropertyOptional({ description: 'L\'id de l\'utilisateur qui recoit le message' })
  @IsUUID()
  @IsOptional()
  receiver_user_id?: string;

  @ApiPropertyOptional({ description: 'Message initial' })
  @IsString()
  seed_message: string;

  @ApiPropertyOptional({ description: 'ID du restaurant' })
  @IsUUID()
  @IsOptional()
  restaurant_id?: string;
}
