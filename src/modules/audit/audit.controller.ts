import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { Action } from 'src/modules/auth/enums/action.enum';
import { AuditService } from './audit.service';

/**
 * Consultation du journal d'audit — RÉSERVÉ à l'ADMIN (permission AUDIT/READ,
 * que seul le rôle ADMIN possède via `Modules.ALL`).
 */
@ApiTags('Audit')
@Controller('audit-logs')
@UseGuards(JwtAuthGuard, UserPermissionsGuard)
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  @RequirePermission(Modules.AUDIT, Action.READ)
  @ApiOperation({ summary: 'Journal d\'audit paginé + filtré (view=actions|logs)' })
  list(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('view') view?: 'actions' | 'logs',
    @Query('actor_id') actor_id?: string,
    @Query('module') module?: string,
    @Query('action') action?: string,
    @Query('method') method?: string,
    @Query('errors_only') errors_only?: string,
    @Query('search') search?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.auditService.list({
      page: Number(page) || 1,
      limit: Number(limit) || 25,
      view: view === 'actions' || view === 'logs' ? view : undefined,
      actor_id,
      module,
      action,
      method,
      errors_only: errors_only === 'true' || errors_only === '1',
      search,
      from,
      to,
    });
  }

  @Get('filters')
  @RequirePermission(Modules.AUDIT, Action.READ)
  @ApiOperation({ summary: 'Valeurs de filtres (modules + auteurs) pour l\'UI' })
  filters() {
    return this.auditService.filters();
  }
}
