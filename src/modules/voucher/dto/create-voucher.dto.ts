import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsDateString, IsNotEmpty, IsOptional, IsUUID } from "class-validator";
import { isValid, parse } from "date-fns";

export class CreateVoucherDto {
  @ApiProperty({
    description: 'Montant initial du bon',
    example: 100.0,
  })
  @IsNotEmpty()
  @Transform(({ value }) => Number(value))
  initialAmount: number;

  @ApiProperty({
    description: 'ID du client',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsNotEmpty()
  @IsUUID()
  customerId: string;

  @ApiPropertyOptional({
    description: 'Date d\'expiration du bon',
    example: '2023-12-31T23:59:59.999Z',
  })

  @IsDateString({}, { message: 'La date de naissance doit être au format JJ/MM/AAAA' })
  @IsOptional()
  @Transform(({ value }) => {
    const parsedDate = parse(value, 'dd/MM/yyyy', new Date());
    if (isValid(parsedDate)) {
      return parsedDate.toISOString();
    }
    return value;
  })
  expiresAt?: string;
}
