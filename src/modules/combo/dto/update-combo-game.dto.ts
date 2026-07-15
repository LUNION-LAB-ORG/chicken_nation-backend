import { PartialType } from '@nestjs/swagger';
import { CreateComboGameDto } from './create-combo-game.dto';

/**
 * Mise à jour d'un COMBO MYSTÈRE (back office). Tous les champs optionnels.
 * Le service n'autorise l'édition que tant que le jeu n'est pas SETTLED.
 */
export class UpdateComboGameDto extends PartialType(CreateComboGameDto) {}
