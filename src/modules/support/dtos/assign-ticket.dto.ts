import { IsNotEmpty, IsUUID } from "class-validator";

export class assignTicketDto {
    @IsNotEmpty()
    @IsUUID()
    assigneeId: string;
}