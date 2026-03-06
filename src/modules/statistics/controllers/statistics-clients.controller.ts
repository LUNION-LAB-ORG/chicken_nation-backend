import { Controller, Get, Param, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { CacheInterceptor, CacheTTL } from '@nestjs/cache-manager';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { StatisticsClientsService } from '../services/statistics-clients.service';
import { ClientsStatsQueryDto, InactiveClientsQueryDto } from '../dto/clients-stats.dto';

@Controller('statistics/clients')
@UseGuards(JwtAuthGuard, UserPermissionsGuard)
@UseInterceptors(CacheInterceptor)
export class StatisticsClientsController {
  constructor(private readonly clientsService: StatisticsClientsService) {}

  /**
   * GET /statistics/clients/overview
   * Total clients, nouveaux vs récurrents, LTV, panier moyen, canaux (App/Call).
   * Filtres : restaurantId, startDate, endDate, period
   */
  @Get('overview')
  @RequirePermission(Modules.CLIENTS, Action.READ)
  @CacheTTL(5 * 60 * 1000)
  async getClientsOverview(@Query() query: ClientsStatsQueryDto) {
    return this.clientsService.getClientsOverview(query);
  }

  /**
   * GET /statistics/clients/acquisition
   * Courbe journalière : nouveaux vs récurrents, App vs Call Center.
   * Filtres : restaurantId, startDate, endDate, period
   */
  @Get('acquisition')
  @RequirePermission(Modules.CLIENTS, Action.READ)
  @CacheTTL(5 * 60 * 1000)
  async getClientsAcquisition(@Query() query: ClientsStatsQueryDto) {
    return this.clientsService.getClientsAcquisition(query);
  }

  /**
   * GET /statistics/clients/retention
   * Taux de churn 30j / 60j, clients à risque, taux de rétention.
   * Filtres : restaurantId
   */
  @Get('retention')
  @RequirePermission(Modules.CLIENTS, Action.READ)
  @CacheTTL(10 * 60 * 1000)
  async getClientsRetention(@Query() query: ClientsStatsQueryDto) {
    return this.clientsService.getClientsRetention(query);
  }

  /**
   * GET /statistics/clients/top
   * Top clients par CA (LTV) avec canal préféré, panier moyen et fidélité.
   * Filtres : restaurantId, startDate, endDate, period, limit
   */
  @Get('top')
  @RequirePermission(Modules.CLIENTS, Action.READ)
  @CacheTTL(5 * 60 * 1000)
  async getTopClients(@Query() query: ClientsStatsQueryDto) {
    return this.clientsService.getTopClients(query);
  }

  /**
   * GET /statistics/clients/inactive
   * Liste des clients inactifs depuis N jours, exportable pour campagnes SMS/WhatsApp.
   * Filtres : restaurantId, inactiveDays (défaut: 30), limit
   */
  @Get('inactive')
  @RequirePermission(Modules.CLIENTS, Action.READ)
  async getInactiveClients(@Query() query: InactiveClientsQueryDto) {
    return this.clientsService.getInactiveClients(query);
  }

  /**
   * GET /statistics/clients/by-zone
   * Répartition géographique des clients actifs.
   * Filtres : restaurantId, startDate, endDate, period, limit
   */
  @Get('by-zone')
  @RequirePermission(Modules.CLIENTS, Action.READ)
  @CacheTTL(5 * 60 * 1000)
  async getClientsByZone(@Query() query: ClientsStatsQueryDto) {
    return this.clientsService.getClientsByZone(query);
  }

  /**
   * GET /statistics/clients/:id/analytics
   * Fiche analytique complète d'un client : canal préféré, LTV, fréquence, top plats, fidélité.
   */
  @Get(':id/analytics')
  @RequirePermission(Modules.CLIENTS, Action.READ)
  @CacheTTL(5 * 60 * 1000)
  async getClientAnalyticsProfile(@Param('id') id: string) {
    return this.clientsService.getClientAnalyticsProfile(id);
  }
}
