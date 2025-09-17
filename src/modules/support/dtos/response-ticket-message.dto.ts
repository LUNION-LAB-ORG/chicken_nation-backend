import { ApiProperty } from "@nestjs/swagger";

export class ResponseTicketMessageDto {
    @ApiProperty()
    id: string;

    @ApiProperty()
    body: string;

    @ApiProperty()
    internal: boolean;

    @ApiProperty()
    isRead: boolean;

    @ApiProperty()
    createdAt: string;

    @ApiProperty()
    updatedAt: string;

    @ApiProperty({ required: false })
    authorUser?: {
        id: string;
        name: string;
        email: string;
        image?: string | null;
    } | null;

    @ApiProperty({ required: false })
    authorCustomer?: {
        id: string;
        name: string;
        first_name?: string | null;
        last_name?: string | null;
        image?: string | null;
    } | null;

    @ApiProperty()
    ticket: {
        id: string;
        code: string;
    };
}