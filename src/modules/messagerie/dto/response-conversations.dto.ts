import { ApiProperty } from '@nestjs/swagger';
import { IsOptional } from 'class-validator';
import { ResponseMessageDto } from './response-message.dto';

export class ResponseConversationsDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  unreadNumber: number;

  @ApiProperty()
  customerId: string;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty({ type: [Object] })
  messages: Omit<ResponseMessageDto, 'conversationId' | 'conversation'>[];

  @ApiProperty({ type: [Object] })
  restaurant?: {
    id: string;
    name: string;
    image:string
  } | null;

  @ApiProperty({ required: false })
  @IsOptional()
  customer?: {
    id: string;
    first_name: string;
    last_name: string;
    email: string;
    phone: string;
    image: string;
  } | null;

  @ApiProperty({ type: [Object] })
  users: {
    id: string;
    fullName: string;
    image: string | null;
  }[];
}
