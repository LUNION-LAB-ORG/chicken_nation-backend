import { IsNotEmpty, IsUUID } from 'class-validator';

export class AgentToCategoryDto {
    @IsNotEmpty()
    @IsUUID()
    agentId: string;

    @IsNotEmpty()
    @IsUUID()
    categoryId: string;
}