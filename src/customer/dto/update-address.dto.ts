import { PartialType } from '@nestjs/swagger';
import { CreateAddressDto } from 'src/customer/dto/create-address.dto';

export class UpdateAddressDto extends PartialType(CreateAddressDto) {}
