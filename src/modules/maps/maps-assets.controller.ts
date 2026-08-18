import {
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { PINS_VIGNETTE } from './constants/pins.constant';

/**
 * Pastilles de la vignette d'itinéraire, servies PUBLIQUEMENT.
 *
 * C'est Google qui vient les chercher, depuis ses propres serveurs, pour les
 * poser sur la carte : elles ne peuvent donc pas vivre derrière le jeton comme
 * le reste du module. Ce sont deux images fixes, elles ne révèlent rien.
 *
 * Contrôleur séparé exprès : `MapsController` porte `AnyJwtAuthGuard` sur toute
 * sa surface, et une exception au milieu d'un contrôleur protégé est le genre
 * de détail qu'on oublie en relisant.
 */
@ApiTags('Maps')
@Controller('maps')
export class MapsAssetsController {
  @Get('pin/:nom')
  @ApiOperation({ summary: "Pastille d'un marqueur d'itinéraire (PNG public)" })
  // Images fixes : on laisse Google et les intermédiaires les garder longtemps.
  @Header('Cache-Control', 'public, max-age=2592000, immutable')
  @Header('Content-Type', 'image/png')
  pin(@Param('nom') nom: string, @Res() res: Response) {
    // `.png` toléré dans l'URL : Google suit plus volontiers une adresse qui
    // ressemble à un fichier image.
    const cle = nom.replace(/\.png$/i, '');
    const image = PINS_VIGNETTE.get(cle);
    // Ceinture : rien d'autre qu'une image ne doit atteindre `res.send`, qui
    // sur autre chose casse en 500 et fait écrire une ligne de journal d'audit
    // à chaque appel, depuis n'importe où sur Internet.
    if (!Buffer.isBuffer(image)) throw new NotFoundException('Pastille inconnue');
    res.send(image);
  }
}
