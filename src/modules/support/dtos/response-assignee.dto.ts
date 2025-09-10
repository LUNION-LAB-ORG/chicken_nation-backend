import { ApiProperty } from '@nestjs/swagger';

export class AssigneeResponseDto {
    @ApiProperty({ description: 'The ID of the assignee' })
    id: string;

    @ApiProperty({ description: 'The full name of the assignee' })
    fullname: string;

    @ApiProperty({ description: 'The image URL of the assignee' })
    image: string | null;
}