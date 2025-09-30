import { ApiProperty } from "@nestjs/swagger";
import { EntityStatus, VoucherStatus } from "@prisma/client";

export class VoucherResponseDto {
  @ApiProperty({
    description: 'Identifiant unique du bon',
    example: 'a1b2c3d4-e5f6-7g8h-9i0j-k1l2m3n4o5p6',
  })
  id: string;

  @ApiProperty({
    description: 'Code unique du bon',
    example: 'ABC123XYZ',
  })
  code: string;

  @ApiProperty({
    description: 'Montant initial du bon',
    example: 100.0,
  })
  initialAmount: number;

  @ApiProperty({
    description: 'Montant restant du bon',
    example: 75.0,
  })
  remainingAmount: number;

  @ApiProperty({
    description: 'Informations sur le client associé au bon',
    type: () => ({
      id: 'string',
      email: 'string',
      firstName: 'string',
      lastName: 'string',
      phone: 'string | null',
    }),
  })
  customer: {
    id: string;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
  };

  @ApiProperty({
    description: 'Statut du bon',
    example: 'ACTIVE',
    enum: VoucherStatus,
  })
  status: VoucherStatus;
  createdAt: Date;
  updatedAt: Date;
  @ApiProperty({
    description: "Date d'expiration du bon",
    example: '2024-12-31T23:59:59.000Z',
    nullable: true,
  })
  expiresAt?: Date | null;

  @ApiProperty({
    description: 'Informations sur l’utilisateur qui a créé le bon',
    type: () => ({
      id: 'string',
      email: 'string',
      fullName: 'string',
    }),
  })
  createdBy: {
    id: string;
    email: string;
    fullName: string;
  };

  @ApiProperty({
    description: 'Statut de l’entité',
    example: 'ACTIVE',
    enum: EntityStatus,
  })
  entityStatus: EntityStatus;
}