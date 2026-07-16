import { IsArray, IsBoolean, IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DishAudience, OrderType, SpiceLevel } from '@prisma/client';

export class CreateDishDto {
  @ApiProperty({ description: 'Nom du plat' })
  @IsNotEmpty()
  @IsString()
  @Transform(({ value }) => value.trim())
  name: string;

  @ApiPropertyOptional({ description: 'Description du plat' })
  @IsOptional()
  @IsString()
  @Transform(({ value }) => value.trim())
  description?: string;

  @ApiProperty({ description: 'Prix du plat' })
  @IsNotEmpty()
  @IsNumber()
  @Transform(({ value }) => Number(value))
  price: number;

  @ApiPropertyOptional({ description: 'Image du plat', type: "file" as "string" })
  @IsOptional()
  @IsString()
  image?: string;

  @ApiPropertyOptional({ description: 'Promotion du plat' })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => String(value).trim() == "true" ? true : false)
  is_promotion?: boolean = false;

  @ApiPropertyOptional({ description: 'Est-ce que le plat est toujours épicé ? (déprécié : voir spice_level)' })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => String(value).trim() == "true" ? true : false)
  is_alway_epice?: boolean = false;

  @ApiPropertyOptional({
    description: 'Niveau épicé : ALWAYS (toujours épicé, badge), OPTIONAL (au choix du client), NEVER (jamais)',
    enum: SpiceLevel,
  })
  @IsOptional()
  @IsEnum(SpiceLevel)
  spice_level?: SpiceLevel;

  @ApiPropertyOptional({
    enum: OrderType,
    isArray: true,
    description: "Modes de commande où le plat est disponible (défaut : tous). DELIVERY absent = « Pas à livrer ».",
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null || value === '') return undefined;
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') return value.split(',').map((v) => v.trim()).filter(Boolean);
    return value;
  })
  @IsArray()
  @IsEnum(OrderType, { each: true })
  available_order_types?: OrderType[];

  @ApiPropertyOptional({ description: "Heure de début de disponibilité « HH:mm » (vide/null = toujours dispo)" })
  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === null || value === '' ? null : String(value).trim()))
  @IsString()
  available_from?: string | null;

  @ApiPropertyOptional({ description: "Heure de fin de disponibilité « HH:mm » (vide/null = toujours dispo)" })
  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === null || value === '' ? null : String(value).trim()))
  @IsString()
  available_until?: string | null;

  @ApiPropertyOptional({ description: 'Prix de promotion du plat' })
  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => Number(value))
  promotion_price?: number;

  @ApiProperty({ description: 'ID de la catégorie', example: '123' })
  @IsNotEmpty()
  @IsUUID()
  category_id: string;

  @ApiPropertyOptional({ description: 'Temps de préparation du plat en minutes', example: 15 })
  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => Number(value))
  cooking_time: number
  // en minutes

  @ApiPropertyOptional({ description: 'ID des restaurants', example: ['123', '456'] })
  @IsOptional()
  @IsUUID(undefined, { each: true })
  restaurant_ids?: string[];

  @ApiPropertyOptional({ description: 'ID des suppléments', example: ['123', '456'] })
  @IsOptional()
  @IsUUID(undefined, { each: true })
  supplement_ids?: string[];

  // ===== Modèle "tout par défaut − exclusions" =====
  // Par défaut un plat propose TOUS les suppléments et est vendu dans TOUS les
  // restaurants. Ces listes contiennent les EXCLUSIONS (ce qu'on retire).
  @ApiPropertyOptional({ description: "IDs des restaurants où le plat N'est PAS vendu (exclusions)", example: ['123'] })
  @IsOptional()
  @IsUUID(undefined, { each: true })
  excluded_restaurant_ids?: string[];

  @ApiPropertyOptional({ description: 'IDs des suppléments NON proposés par le plat (exclusions)', example: ['123'] })
  @IsOptional()
  @IsUUID(undefined, { each: true })
  excluded_supplement_ids?: string[];

  @ApiPropertyOptional({ description: "Remplacer entièrement les exclusions (même vides) lors d'un update" })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => String(value).trim() == "true" ? true : false)
  manage_exclusions?: boolean;

  @ApiPropertyOptional({ description: "Si le plat est privée" })
  @IsOptional()
  @Transform(({ value }) => String(value).trim() == "true" ? true : false)
  @IsBoolean()
  private?: boolean;

  @ApiPropertyOptional({
    enum: DishAudience,
    isArray: true,
    description:
      "Audiences ciblées (vide = PUBLIC, tout le monde). ETUDIANT = carte étudiant ; STANDARD/VIP/VVIP = niveau de fidélité. Match strict, multi-valeurs.",
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null || value === '') return [];
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') return value.split(',').map((v) => v.trim()).filter(Boolean);
    return value;
  })
  @IsArray()
  @IsEnum(DishAudience, { each: true })
  audiences?: DishAudience[];

  @ApiPropertyOptional({ description: 'SKU HubRise pour la correspondance catalogue' })
  @IsOptional()
  @IsString()
  @Transform(({ value }) => value?.trim())
  hubrise_sku?: string;
}