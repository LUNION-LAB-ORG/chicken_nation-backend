import { ApiProperty } from '@nestjs/swagger';
import { IsOptional } from 'class-validator';

export class ResponseConversationsDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  restaurantId: string;

  @ApiProperty()
  customerId: string;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty({ type: [Object] })
  messages: {
    id: string;
    body: string;
    authorUserId?: string;
    authorCustomerId?: string;
    createdAt: Date;
    updatedAt: Date;
  }[];

  @ApiProperty({ required: false })
  @IsOptional()
  customer?: {
    id: string;
    first_name?: string;
    last_name?: string;
  } | null;

  @ApiProperty({ type: [Object] })
  users: {
    id: string;
    fullname: string;
  }[];
}
