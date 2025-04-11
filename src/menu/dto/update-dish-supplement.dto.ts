import { PartialType } from '@nestjs/swagger';
import { CreateDishSupplementDto } from 'src/menu/dto/create-dish-supplement.dto';

export class UpdateDishSupplementDto extends PartialType(CreateDishSupplementDto) {}
