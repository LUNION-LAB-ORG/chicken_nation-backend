import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query, UseGuards } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';

import { UserRoles } from 'src/modules/auth/decorators/user-roles.decorator';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserRolesGuard } from 'src/modules/auth/guards/user-roles.guard';

import { AssignDelivererDto } from '../dto/assign-deliverer.dto';
import { CancelCourseDto } from '../dto/cancel-course.dto';
import { QueryCourseStatsDto } from '../dto/query-course-stats.dto';
import { QueryCoursesDto } from '../dto/query-courses.dto';
import { CourseActionService } from '../services/course-action.service';
import { CourseOfferService } from '../services/course-offer.service';
import { CourseQueryService } from '../services/course-query.service';

/**
 * Endpoints admin pour le module course.
 * Restreint à UserRole.ADMIN (même règle que Livreurs).
 */
@ApiTags('Courses — Admin')
@Controller('courses')
@UseGuards(JwtAuthGuard, UserRolesGuard)
@UserRoles(UserRole.ADMIN)
export class CourseAdminController {
  constructor(
    private readonly queryService: CourseQueryService,
    private readonly actionService: CourseActionService,
    private readonly offerService: CourseOfferService,
  ) {}

  @ApiOperation({ summary: 'Liste paginée des courses (toutes)' })
  @Get()
  async findAll(@Query() query: QueryCoursesDto) {
    return this.queryService.findAllAdmin(query);
  }

  @ApiOperation({
    summary: 'Stats agrégées (KPI + daily breakdown + distribution) pour la page Courses',
  })
  @Get('stats')
  async stats(@Query() query: QueryCourseStatsDto) {
    return this.queryService.getStats(query);
  }

  @ApiOperation({ summary: "Détail d'une course (+ tentatives d'affectation)" })
  @Get(':id')
  async findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.queryService.findOne(id);
  }

  @ApiOperation({ summary: 'Forcer l\'affectation à un livreur précis (override admin)' })
  @ApiBody({ type: AssignDelivererDto })
  @Patch(':id/force-assign')
  async forceAssign(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AssignDelivererDto,
  ) {
    await this.offerService.offerToDeliverer(id, dto.deliverer_id);
    return { success: true, message: 'Offer envoyée au livreur' };
  }

  @ApiOperation({ summary: 'Annuler une course (admin)' })
  @ApiBody({ type: CancelCourseDto })
  @Patch(':id/cancel')
  async cancel(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CancelCourseDto,
  ) {
    return this.actionService.cancelCourse(id, 'admin', dto);
  }

  @ApiOperation({
    summary: 'Relancer une course expirée',
    description:
      'Reset les tentatives précédentes (tous les livreurs redeviennent candidats) et relance la recherche.',
  })
  @Patch(':id/retry')
  async retry(@Param('id', new ParseUUIDPipe()) id: string) {
    await this.offerService.retryExpiredCourse(id);
    return { success: true, message: 'Course relancée — recherche de livreur en cours' };
  }
}
