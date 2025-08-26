import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsNumber, IsOptional, IsUUID, Min } from 'class-validator';
import { TicketStatus } from '@prisma/client';
import { Type } from 'class-transformer';

export class QueryConversationsDto {

  @ApiProperty({ required: false, default: 1 })
  @IsOptional() @IsNumber()
  @Min(1) @Type(() => Number)
  page?: number = 1;

  @ApiProperty({ required: false, default: 10 })
  @IsOptional()
  @IsNumber() @Min(0)
  @Type(() => Number)
  limit?: number = 10;

  @ApiPropertyOptional({
    description: 'Rechercher une conversation par restaurant',
  })
  @IsOptional() @IsUUID()
  restaurantId?: string;

  @ApiPropertyOptional({
    description: 'Rechercher une conversation par client',
  })
  @IsOptional() @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({
    description: 'Rechercher une conversation par utilisateur participant',
  })
  @IsOptional() @IsUUID()
  userId?: string;

  @ApiPropertyOptional({ description: 'Obtenir que les conversations interne' })
  @IsOptional() @IsBoolean()
  internalOnly?: boolean;

  // Que les conversations clientes
  @ApiPropertyOptional({ description: 'Que les conversations clientes' })
  @IsOptional() @IsBoolean() @Type(() => Boolean)
  withCustomer?: boolean;

  @IsOptional() @IsEnum(TicketStatus)
  ticketStatus?: 'OPEN' | 'IN_PROGRESS' | 'PENDING' | 'RESOLVED' | 'CLOSED';
}
