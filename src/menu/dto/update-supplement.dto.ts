import { PartialType } from '@nestjs/swagger';
import { CreateSupplementDto } from 'src/menu/dto/create-supplement.dto';

export class UpdateSupplementDto extends PartialType(CreateSupplementDto) {}
