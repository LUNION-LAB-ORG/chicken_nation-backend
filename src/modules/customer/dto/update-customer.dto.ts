import { PartialType } from '@nestjs/swagger';
import { CreateCustomerDto } from 'src/modules/customer/dto/create-customer.dto';

export class UpdateCustomerDto extends PartialType(CreateCustomerDto) {}
