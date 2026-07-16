import {
  Body,
  Controller,
  HttpCode,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { AdhesionService } from './adhesion.service';
import { CreateAdhesionDto } from './dto/create-adhesion.dto';

/**
 * Tunnel d'adhésion (Phase 4) — endpoint PUBLIC consommé par le site vitrine.
 *
 * PAS de garde JWT (le visiteur n'est pas authentifié), MAIS rate-limité par
 * ThrottlerGuard pour empêcher l'abus (spam d'inscriptions / d'envois WhatsApp).
 *
 * multipart/form-data : la PHOTO du titulaire (obligatoire) arrive en fichier
 * (`photo`) ; les autres champs sont des champs de formulaire (strings).
 */
@ApiTags('Adhésion (Tunnel)')
@Controller('adhesion')
@UseGuards(ThrottlerGuard)
export class AdhesionController {
  constructor(private readonly adhesionService: AdhesionService) {}

  @Post()
  @HttpCode(200)
  // Rate limit dédié : 5 adhésions / minute / IP (au-dessus du défaut global).
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('photo'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary:
      'Pré-inscription publique au programme (nom + téléphone + profil + photo)',
  })
  register(
    @Body() dto: CreateAdhesionDto,
    @UploadedFile() photo?: Express.Multer.File,
  ) {
    return this.adhesionService.register(dto, photo);
  }
}
