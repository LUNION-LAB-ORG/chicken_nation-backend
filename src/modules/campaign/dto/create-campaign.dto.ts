import { IsDateString, IsNumber, IsOptional, IsString, IsArray, IsUUID } from 'class-validator';

export class CreateCampaignDto {
  @IsString()
  name: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsDateString()
  start_date: string;

  @IsDateString()
  @IsOptional()
  end_date?: string;

  @IsNumber()
  @IsOptional()
  target_conversion_rate?: number;

  @IsNumber()
  @IsOptional()
  target_contacts_count?: number;

  @IsUUID()
  lead_agent_id: string;

  @IsArray()
  @IsUUID('4', { each: true })
  agent_ids: string[];
}
