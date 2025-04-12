import { PartialType } from '@nestjs/swagger';
import { CreateDishDto } from 'src/modules/menu/dto/create-dish.dto';

export class UpdateDishDto extends PartialType(CreateDishDto) {}
