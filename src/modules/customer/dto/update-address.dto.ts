import { PartialType } from '@nestjs/swagger';
import { CreateAddressDto } from 'src/modules/customer/dto/create-address.dto';

export class UpdateAddressDto extends PartialType(CreateAddressDto) {}
