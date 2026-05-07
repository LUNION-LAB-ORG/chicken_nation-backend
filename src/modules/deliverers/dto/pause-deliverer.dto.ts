import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Payload pour `POST /deliverers/me/pause` — bouton "Je prends une pause"
 * côté mobile. `durationMinutes` est optionnel : si absent, pause
 * indéfinie jusqu'à ce que le livreur appuie sur "Reprendre".
 */
export class PauseDelivererDto {
  @ApiPropertyOptional({
    description:
      'Durée de la pause en minutes. Si absent, pause indéfinie (le livreur ' +
      'devra appeler `/resume` pour sortir de pause).',
    example: 30,
    minimum: 1,
    maximum: 480,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(480) // 8h max — au-delà c'est la fin de journée, qu'il se déconnecte
  durationMinutes?: number;
}
