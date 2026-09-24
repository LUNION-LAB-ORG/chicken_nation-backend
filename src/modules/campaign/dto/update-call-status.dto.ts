import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { ProspectCallResult } from '@prisma/client';

/**
 * Qualification d'un appel depuis la file d'un agent de campagne.
 *
 * `status` n'accepte que les résultats d'appel : c'est ce qui est journalisé
 * dans `ProspectCall`. Le statut du prospect en découle, jamais l'inverse.
 */
export class UpdateCallStatusDto {
  @IsEnum(ProspectCallResult, {
    message: 'Résultat invalide (JOINT, NON_JOIGNABLE ou REFUS)',
  })
  status: ProspectCallResult;

  @IsOptional()
  @IsUUID()
  loss_reason_id?: string;

  @IsOptional()
  @IsString()
  comment?: string;
}
