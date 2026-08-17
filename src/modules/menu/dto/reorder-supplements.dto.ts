import { ApiProperty } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsUUID } from 'class-validator';

/**
 * Réordonnancement d'une catégorie de suppléments.
 *
 * On envoie la liste COMPLÈTE des identifiants dans l'ordre voulu, plutôt que
 * des positions une par une : le gestionnaire déplace un élément et tout le
 * reste se renumérote, sans qu'il ait à recalculer quoi que ce soit ni à
 * craindre deux suppléments au même rang.
 */
export class ReorderSupplementsDto {
    @ApiProperty({
        description: "Identifiants des suppléments, dans l'ordre d'affichage souhaité",
        type: [String],
    })
    @IsArray()
    @ArrayMinSize(1)
    @IsUUID(undefined, { each: true })
    ids: string[];
}
