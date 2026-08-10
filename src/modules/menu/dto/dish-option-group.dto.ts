import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Configuration d'un menu composable, envoyée EN BLOC par le backoffice.
 *
 * L'écran d'édition manipule un arbre complet (groupes puis choix) : le
 * transmettre entier évite une douzaine de petits appels et rend l'opération
 * rejouable. Les identifiants déjà connus sont conservés, ce qui préserve
 * l'historique une fois que des commandes s'y rattacheront.
 */

export class DishOptionItemDto {
  @ApiPropertyOptional({ description: "Identifiant d'un choix existant à conserver" })
  @IsOptional()
  @IsUUID()
  id?: string;

  @ApiProperty({ description: 'Libellé affiché au client (« Mayonnaise »)' })
  @IsNotEmpty()
  @IsString()
  label: string;

  @ApiPropertyOptional({ description: 'Supplément facturé pour ce plat, 0 si le choix est inclus' })
  @IsOptional()
  @IsNumber()
  @Min(0, { message: 'Le supplément d\'un choix ne peut pas être négatif' })
  @Type(() => Number)
  price_delta?: number;

  @ApiPropertyOptional({ description: 'Rattachement facultatif au catalogue de suppléments' })
  @IsOptional()
  @IsUUID()
  supplement_id?: string | null;

  @ApiPropertyOptional({ description: "Présélectionné à l'ouverture" })
  @IsOptional()
  @IsBoolean()
  is_default?: boolean;

  @ApiPropertyOptional({ description: 'Choix proposé, décocher pour une rupture' })
  @IsOptional()
  @IsBoolean()
  available?: boolean;
}

export class DishOptionGroupDto {
  @ApiPropertyOptional({ description: "Identifiant d'un groupe existant à conserver" })
  @IsOptional()
  @IsUUID()
  id?: string;

  @ApiProperty({ description: 'Titre du groupe (« Choix de sauce »)' })
  @IsNotEmpty()
  @IsString()
  name: string;

  @ApiPropertyOptional({ description: 'Aide affichée sous le titre' })
  @IsOptional()
  @IsString()
  description?: string | null;

  @ApiPropertyOptional({ description: 'Le client doit répondre pour pouvoir commander' })
  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @ApiPropertyOptional({ description: 'Nombre minimum de choix' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  min_select?: number;

  @ApiPropertyOptional({ description: 'Nombre maximum de choix' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  max_select?: number;

  @ApiProperty({ description: 'Choix proposés dans ce groupe', type: [DishOptionItemDto] })
  @IsArray()
  @ArrayMinSize(1, { message: 'Un groupe doit proposer au moins un choix' })
  @ValidateNested({ each: true })
  @Type(() => DishOptionItemDto)
  items: DishOptionItemDto[];
}

export class ReplaceDishOptionGroupsDto {
  @ApiProperty({ description: "Configuration complète du plat", type: [DishOptionGroupDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DishOptionGroupDto)
  groups: DishOptionGroupDto[];
}
