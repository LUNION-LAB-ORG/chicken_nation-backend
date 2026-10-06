import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

export class RenumeroterCartesDto {
  @ApiPropertyOptional({
    description:
      "VRAI par défaut : la route compte et montre, sans rien écrire. Passer `false` pour renuméroter réellement. L'opération est IRRÉVERSIBLE et l'ancien numéro, déjà chez le client, ne correspondra plus à rien.",
    example: false,
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  simulation?: boolean;

  @ApiPropertyOptional({
    description:
      'Taille du lot (1 à 200, 50 par défaut). Chaque carte redessine une image et la dépose sur S3 : traiter tout un parc en une requête dépasserait le délai.',
    example: 50,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limite?: number;
}
