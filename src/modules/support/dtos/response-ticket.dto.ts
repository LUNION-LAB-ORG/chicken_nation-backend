// ...existing code...
import { ApiProperty } from '@nestjs/swagger';
import { EntityStatus, UserRole, UserType } from '@prisma/client';
import { IsOptional } from 'class-validator';

class ResponseTicketCustomerDto {
    @ApiProperty()
    id: string;

    @ApiProperty()
    name: string;

    @ApiProperty({ required: false, nullable: true })
    email: string | null;

    @ApiProperty({ required: false, nullable: true })
    image: string | null;

    @ApiProperty({ required: false, nullable: true })
    first_name: string | null;

    @ApiProperty({ required: false, nullable: true })
    last_name: string | null;
}

class ResponseTicketRestaurantDto {
    @ApiProperty()
    id: string;

    @ApiProperty({ required: false, nullable: true })
    email: string | null;

    @ApiProperty({ required: false, nullable: true })
    schedule: Record<string, any> | null;
}

class ResponseTicketAssigneeDto {
    @ApiProperty()
    id: string;

    @ApiProperty()
    fullname: string;

    @ApiProperty()
    email: string;

    @ApiProperty({ required: false, nullable: true })
    phone: string | null;

    @ApiProperty({ required: false, nullable: true })
    image: string | null;

    @ApiProperty({ enum: UserRole })
    role: UserRole;
}

class ResponseTicketParticipantDto extends ResponseTicketAssigneeDto { }

class ResponseTicketMessageDto {
    @ApiProperty()
    id: string;

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

    @ApiProperty({ description: 'Indique si le message est interne (non visible par le client)', default: false })
    internal: boolean;
}

class ResponseTicketOrderDto {
    @ApiProperty()
    id: string;

    @ApiProperty()
    reference: string;

    @ApiProperty()
    restaurantId: string;
}

export class ResponseTicketDto {
    @ApiProperty()
    id: string;

    @ApiProperty()
    code: string;

    @ApiProperty({ type: ResponseTicketCustomerDto, required: false, nullable: true })
    @IsOptional()
    customer: ResponseTicketCustomerDto | null;

    @ApiProperty({ type: ResponseTicketAssigneeDto, required: false, nullable: true })
    @IsOptional()
    assignee: ResponseTicketAssigneeDto | null;

    @ApiProperty({ type: [ResponseTicketParticipantDto] })
    participants: ResponseTicketParticipantDto[];

    @ApiProperty({ type: [ResponseTicketMessageDto] })
    messages: ResponseTicketMessageDto[];

    @ApiProperty({ type: ResponseTicketOrderDto })
    order: ResponseTicketOrderDto;
}