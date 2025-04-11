import { PartialType } from '@nestjs/swagger';
import { CreateDishDto } from 'src/menu/dto/create-dish.dto';

export class UpdateDishDto extends PartialType(CreateDishDto) {}
