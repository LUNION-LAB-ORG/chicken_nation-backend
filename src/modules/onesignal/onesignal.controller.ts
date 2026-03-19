import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { OnesignalService } from './onesignal.service';
import { OnesignalTagsTask } from './tasks/onesignal-tags.task';
import { ScheduledNotificationService } from './scheduled-notification.service';
import { SettingsService } from 'src/modules/settings/settings.service';
import { CreateMessageDto } from './dto/create-message.dto';
import { ViewMessagesQueryDto, ViewTemplatesQueryDto, ViewSegmentsQueryDto } from './dto/view-messages-query.dto';
import { CreateTemplateDto } from './dto/create-template.dto';
import { UpdateTemplateDto } from './dto/update-template.dto';
import { CreateSegmentDto } from './dto/create-segment.dto';
import { UpdateSegmentDto } from './dto/update-segment.dto';
import { CreateScheduledNotificationDto } from './dto/create-scheduled-notification.dto';
import { UpdateScheduledNotificationDto } from './dto/update-scheduled-notification.dto';

@ApiTags('OneSignal')
@ApiBearerAuth()
@Controller('onesignal')
@UseGuards(JwtAuthGuard)
export class OnesignalController {
  constructor(
    private readonly onesignalService: OnesignalService,
    private readonly onesignalTagsTask: OnesignalTagsTask,
    private readonly scheduledNotificationService: ScheduledNotificationService,
    private readonly settingsService: SettingsService,
  ) {}

  // ── Messages ──

  @Post('messages')
  @ApiOperation({ summary: 'Envoyer une notification (push/email/sms)' })
  createMessage(@Body() dto: CreateMessageDto) {
    return this.onesignalService.createMessage(dto);
  }

  @Get('messages')
  @ApiOperation({ summary: 'Liste des messages envoyés' })
  viewMessages(@Query() query: ViewMessagesQueryDto) {
    return this.onesignalService.viewMessages(query);
  }

  @Get('messages/:id')
  @ApiOperation({ summary: 'Détail d\'un message' })
  viewMessage(@Param('id') id: string) {
    return this.onesignalService.viewMessage(id);
  }

  @Delete('messages/:id')
  @ApiOperation({ summary: 'Annuler un message planifié' })
  cancelMessage(@Param('id') id: string) {
    return this.onesignalService.cancelMessage(id);
  }

  @Post('messages/:id/history')
  @ApiOperation({ summary: 'Historique d\'envoi d\'un message' })
  messageHistory(
    @Param('id') id: string,
    @Body('events') events: 'sent' | 'clicked',
  ) {
    return this.onesignalService.messageHistory(id, events);
  }

  // ── Templates ──

  @Post('templates')
  @ApiOperation({ summary: 'Créer un template' })
  createTemplate(@Body() dto: CreateTemplateDto) {
    return this.onesignalService.createTemplate(dto);
  }

  @Get('templates')
  @ApiOperation({ summary: 'Liste des templates' })
  viewTemplates(@Query() query: ViewTemplatesQueryDto) {
    return this.onesignalService.viewTemplates(query);
  }

  @Get('templates/:id')
  @ApiOperation({ summary: 'Détail d\'un template' })
  viewTemplate(@Param('id') id: string) {
    return this.onesignalService.viewTemplate(id);
  }

  @Patch('templates/:id')
  @ApiOperation({ summary: 'Modifier un template' })
  updateTemplate(@Param('id') id: string, @Body() dto: UpdateTemplateDto) {
    return this.onesignalService.updateTemplate(id, dto);
  }

  @Delete('templates/:id')
  @ApiOperation({ summary: 'Supprimer un template' })
  deleteTemplate(@Param('id') id: string) {
    return this.onesignalService.deleteTemplate(id);
  }

  // ── Segments ──

  @Get('segments')
  @ApiOperation({ summary: 'Liste des segments' })
  viewSegments(@Query() query: ViewSegmentsQueryDto) {
    return this.onesignalService.viewSegments(query);
  }

  @Post('segments')
  @ApiOperation({ summary: 'Créer un segment' })
  createSegment(@Body() dto: CreateSegmentDto) {
    return this.onesignalService.createSegment(dto);
  }

  @Patch('segments/:id')
  @ApiOperation({ summary: 'Modifier un segment' })
  updateSegment(@Param('id') id: string, @Body() dto: UpdateSegmentDto) {
    return this.onesignalService.updateSegment(id, dto);
  }

  @Delete('segments/:id')
  @ApiOperation({ summary: 'Supprimer un segment' })
  deleteSegment(@Param('id') id: string) {
    return this.onesignalService.deleteSegment(id);
  }

  // ── Scheduled Notifications ──

  @Post('scheduled')
  @ApiOperation({ summary: 'Créer une notification planifiée / récurrente' })
  createScheduled(@Req() req: Request, @Body() dto: CreateScheduledNotificationDto) {
    const user = req.user as { id: string };
    return this.scheduledNotificationService.create(dto, user.id);
  }

  @Get('scheduled')
  @ApiOperation({ summary: 'Liste des notifications planifiées' })
  listScheduled(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.scheduledNotificationService.findAll(
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 20,
    );
  }

  @Get('scheduled/:id')
  @ApiOperation({ summary: 'Détail d\'une notification planifiée' })
  getScheduled(@Param('id') id: string) {
    return this.scheduledNotificationService.findOne(id);
  }

  @Patch('scheduled/:id')
  @ApiOperation({ summary: 'Modifier une notification planifiée' })
  updateScheduled(@Param('id') id: string, @Body() dto: UpdateScheduledNotificationDto) {
    return this.scheduledNotificationService.update(id, dto);
  }

  @Patch('scheduled/:id/toggle')
  @ApiOperation({ summary: 'Activer / désactiver une notification planifiée' })
  toggleScheduled(@Param('id') id: string, @Body('active') active: boolean) {
    return this.scheduledNotificationService.toggleActive(id, active);
  }

  @Delete('scheduled/:id')
  @ApiOperation({ summary: 'Supprimer une notification planifiée' })
  removeScheduled(@Param('id') id: string) {
    return this.scheduledNotificationService.remove(id);
  }

  // ── Tags Sync ──

  @Post('tags/sync')
  @ApiOperation({ summary: 'Déclencher manuellement la synchronisation des tags OneSignal' })
  async triggerTagsSync(@Body('full') full?: boolean) {
    // Si full=true, forcer un full sync
    if (full) {
      await this.settingsService.set('onesignal_tags_force_full_sync', 'true');
    }
    // Lancer en arrière-plan sans bloquer la réponse HTTP
    this.onesignalTagsTask.syncTags().catch((err) => {
      // Les erreurs sont déjà loguées dans le task
    });
    return {
      message: full
        ? 'Full sync des tags lancé en arrière-plan. Consultez les logs pour suivre la progression.'
        : 'Synchronisation des tags lancée en arrière-plan. Consultez les logs pour suivre la progression.',
    };
  }
}
