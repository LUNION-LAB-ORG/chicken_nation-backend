import { PartialType } from '@nestjs/swagger';
import { CreateCategoryDto } from 'src/modules/menu/dto/create-category.dto';

export class UpdateCategoryDto extends PartialType(CreateCategoryDto) {}
