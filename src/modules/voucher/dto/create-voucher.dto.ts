import { ApiProperty } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsNotEmpty, IsOptional } from "class-validator";

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
  customerId: string;

  @ApiProperty({
    description: 'Date d\'expiration du bon',
    example: '2023-12-31T23:59:59.999Z',
  })
  @IsOptional()
  @Transform(({ value }) => value ? new Date(value) : null)
  expiresAt?: Date | null = null;
}
