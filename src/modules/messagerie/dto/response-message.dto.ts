import { ApiProperty } from '@nestjs/swagger';
import { IsOptional } from 'class-validator';

export class ResponseMessageDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ type: [Object] })
  conversation: {
    id: string;
    restaurantId: string;
    customerId?: string | null;
  };

  @ApiProperty()
  body: string;

  @ApiProperty()
  isRead: boolean;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;

  @ApiProperty({ required: false })
  @IsOptional()
  authorUser?: {
    id: string;
    name: string;
    email: string;
    image?: string | null;
  } | null;

  @ApiProperty({ required: false })
  @IsOptional()
  authorCustomer?: {
    id: string;
    name: string;
    first_name?: string | null;
    last_name?: string | null;
    image?: string | null;
  } | null;

  @ApiProperty({ required: false })
  @IsOptional()
  meta?: {
    imageUrl?: string | null;
    orderId?: string | null;
  };
}