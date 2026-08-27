import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { User } from '@prisma/client';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { ApercuAudienceDto, CreerDiffusionDto } from './dto/message-broadcast.dto';
import { MessageBroadcastService } from './message-broadcast.service';

/**
 * LISTE DE DIFFUSION DE MESSAGES.
 *
 * Envoyer le même message à une liste de clients, sur un segment ou une
 * sélection. Le pendant des campagnes push, mais la livraison est un message
 * dans le canal officiel du client, pas une notification.
 *
 * ⚠️ Permission MARKETING, et surtout PAS MESSAGES.
 *
 * `MESSAGES` est la permission qui sert à lire et à répondre aux conversations :
 * les rôles CAISSIER et CALL_CENTER la détiennent (voir `permissionsByRole`).
 * L'y rattacher aurait permis à un caissier d'écrire à toute la base de clients
 * depuis sa caisse. Écrire à des milliers de personnes est une décision de
 * marketing, pas un geste de première ligne, et c'est le rôle MARKETING qui la
 * porte, comme pour les actualités.
 */
@ApiTags('Messagerie')
@ApiBearerAuth()
@Controller('message-broadcasts')
@UseGuards(JwtAuthGuard, UserPermissionsGuard)
export class MessageBroadcastController {
  constructor(private readonly service: MessageBroadcastService) {}

  @Get()
  @ApiOperation({ summary: 'Liste des diffusions' })
  @RequirePermission(Modules.MARKETING, Action.READ)
  lister(@Query('status') status?: string) {
    return this.service.lister(status);
  }

  @Get('clients')
  @ApiOperation({ summary: 'Chercher des clients pour une sélection personnalisée' })
  @RequirePermission(Modules.MARKETING, Action.READ)
  chercherClients(@Query('search') search = '') {
    return this.service.chercherClients(search);
  }

  @Post('apercu')
  @ApiOperation({ summary: "Combien de clients ce ciblage désigne-t-il (sans rien écrire)" })
  @RequirePermission(Modules.MARKETING, Action.READ)
  apercu(@Body() dto: ApercuAudienceDto) {
    return this.service.apercu(dto);
  }

  @Post()
  @ApiOperation({ summary: 'Créer une diffusion et figer ses destinataires' })
  @ApiConsumes('multipart/form-data')
  @RequirePermission(Modules.MARKETING, Action.CREATE)
  @UseInterceptors(FileInterceptor('image'))
  creer(
    @Req() req: Request,
    @Body() dto: CreerDiffusionDto,
    @UploadedFile() image?: Express.Multer.File,
  ) {
    const user = req.user as User;
    return this.service.creer(dto, user?.email ?? user?.id ?? 'inconnu', image);
  }

  @Get(':id')
  @ApiOperation({ summary: "Détail et compteurs d'une diffusion" })
  @RequirePermission(Modules.MARKETING, Action.READ)
  detail(@Param('id') id: string) {
    return this.service.detail(id);
  }

  @Post(':id/envoyer')
  @ApiOperation({ summary: "Lancer l'envoi" })
  @RequirePermission(Modules.MARKETING, Action.UPDATE)
  envoyer(@Param('id') id: string) {
    return this.service.envoyer(id);
  }

  @Post(':id/reprendre')
  @ApiOperation({
    summary: "Reprendre une diffusion interrompue (redémarrage, perte de la file)",
  })
  @RequirePermission(Modules.MARKETING, Action.UPDATE)
  reprendre(@Param('id') id: string) {
    return this.service.reprendre(id);
  }
}
