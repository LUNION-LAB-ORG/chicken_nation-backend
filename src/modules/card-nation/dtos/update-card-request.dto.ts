import { PartialType } from '@nestjs/swagger';
import { CreateCardRequestDto } from './create-card-request.dto';

export class UpdateCardRequestDto extends PartialType(CreateCardRequestDto) {}