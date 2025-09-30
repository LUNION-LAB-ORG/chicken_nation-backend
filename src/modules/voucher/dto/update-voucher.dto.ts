import { ApiProperty, PartialType } from '@nestjs/swagger';
import { CreateVoucherDto } from './create-voucher.dto';
import { VoucherStatus } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';
import { Transform } from 'class-transformer';

export class UpdateVoucherDto extends PartialType(CreateVoucherDto) {
  @ApiProperty({
    description: 'Statut du bon',
    example: 'ACTIVE',
    enum: [VoucherStatus.ACTIVE, VoucherStatus.CANCELLED],
  })
  @IsOptional()
  @IsEnum([VoucherStatus.ACTIVE, VoucherStatus.CANCELLED], {
    message: 'Le statut doit être soit ACTIVE soit CANCELLED',
  })
  @Transform(({ value }) => String(value).toUpperCase().trim() as VoucherStatus)
  status: VoucherStatus;
}
