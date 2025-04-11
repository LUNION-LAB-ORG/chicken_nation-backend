import { PartialType } from '@nestjs/swagger';
import { CreateCustomerDto } from 'src/customer/dto/create-customer.dto';

export class UpdateCustomerDto extends PartialType(CreateCustomerDto) {}
