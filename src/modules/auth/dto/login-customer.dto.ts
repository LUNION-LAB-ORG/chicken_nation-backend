import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, MaxLength } from 'class-validator';

export class LoginCustomerDto {
  // PHONE
  @ApiProperty({
    description: "numero de telephone du client",
    example: '+2250777777777',
    required: true,
    maxLength: 20,
  })
  @IsNotEmpty()
  @MaxLength(20)
  @Transform(({ value }) => {
    let phoneNumber = value;
    if (!value.startsWith('+')) {
      phoneNumber = `+${value}`;
    }
    return phoneNumber.replace(/\D/g, '');
  })// supprime les caractères non numériques
  phone: string;
}
