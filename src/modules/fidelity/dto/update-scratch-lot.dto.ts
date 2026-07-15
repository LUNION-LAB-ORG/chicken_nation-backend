import { PartialType } from '@nestjs/swagger';
import { CreateScratchLotDto } from './create-scratch-lot.dto';

/** Mise à jour partielle d'un lot Gratte & Gagne. */
export class UpdateScratchLotDto extends PartialType(CreateScratchLotDto) {}
