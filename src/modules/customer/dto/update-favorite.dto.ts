import { PartialType } from '@nestjs/swagger';
import { CreateFavoriteDto } from 'src/modules/customer/dto/create-favorite.dto';

export class UpdateFavoriteDto extends PartialType(CreateFavoriteDto) {}
