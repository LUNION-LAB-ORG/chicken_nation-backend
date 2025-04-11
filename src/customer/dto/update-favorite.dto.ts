import { PartialType } from '@nestjs/swagger';
import { CreateFavoriteDto } from 'src/customer/dto/create-favorite.dto';

export class UpdateFavoriteDto extends PartialType(CreateFavoriteDto) {}
