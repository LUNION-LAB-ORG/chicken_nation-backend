import { Controller, Post, Body, Req, UseGuards, Get, Query, ParseUUIDPipe } from '@nestjs/common';
import { UserActivityService } from '../services/user-activity.service';
import { TrackActivityDto } from '../dto/track-activity.dto';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { UserRole } from '../../auth/enums/user-role.enum';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { Request } from 'express';

@ApiTags('analytics/user-activity')
@Controller('analytics/user-activity')
export class UserActivityController {
  constructor(private readonly userActivityService: UserActivityService) {}

  @Post('track')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Track user activity' })
  @ApiResponse({ status: 201, description: 'Activity tracked successfully.' })
  @ApiResponse({ status: 401, description: 'Unauthorized.' })
  async trackActivity(
    @Body() activityDto: TrackActivityDto,
    @Req() req: Request,
  ) {
    const userId = req.user['id'];
    return this.userActivityService.trackActivity(userId, activityDto, req);
  }

  @Get('my-activities')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user\'s activities' })
  @ApiResponse({ status: 200, description: 'Returns user\'s activities.' })
  @ApiResponse({ status: 401, description: 'Unauthorized.' })
  @ApiQuery({ name: 'startDate', required: false, type: Date })
  @ApiQuery({ name: 'endDate', required: false, type: Date })
  async getMyActivities(
    @Req() req: Request,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    const userId = req.user['id'];
    return this.userActivityService.getUserActivities(
      userId,
      startDate ? new Date(startDate) : undefined,
      endDate ? new Date(endDate) : undefined,
    );
  }

  @Get('activity-counts')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get activity counts by type (admin only)' })
  @ApiResponse({ status: 200, description: 'Returns activity counts by type.' })
  @ApiResponse({ status: 401, description: 'Unauthorized.' })
  @ApiResponse({ status: 403, description: 'Forbidden.' })
  @ApiQuery({ name: 'startDate', required: true, type: Date })
  @ApiQuery({ name: 'endDate', required: true, type: Date })
  async getActivityCounts(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
  ) {
    return this.userActivityService.getActivityCounts(
      new Date(startDate),
      new Date(endDate),
    );
  }

  @Get('popular-products')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get most viewed products (admin only)' })
  @ApiResponse({ status: 200, description: 'Returns most viewed products.' })
  @ApiResponse({ status: 401, description: 'Unauthorized.' })
  @ApiResponse({ status: 403, description: 'Forbidden.' })
  @ApiQuery({ name: 'startDate', required: true, type: Date })
  @ApiQuery({ name: 'endDate', required: true, type: Date })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getPopularProducts(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('limit') limit?: number,
  ) {
    return this.userActivityService.getProductViewCounts(
      new Date(startDate),
      new Date(endDate),
      limit ? parseInt(limit.toString(), 10) : 10,
    );
  }

  @Get('popular-search-terms')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get most popular search terms (admin only)' })
  @ApiResponse({ status: 200, description: 'Returns most popular search terms.' })
  @ApiResponse({ status: 401, description: 'Unauthorized.' })
  @ApiResponse({ status: 403, description: 'Forbidden.' })
  @ApiQuery({ name: 'startDate', required: true, type: Date })
  @ApiQuery({ name: 'endDate', required: true, type: Date })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getPopularSearchTerms(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('limit') limit?: number,
  ) {
    return this.userActivityService.getSearchTerms(
      new Date(startDate),
      new Date(endDate),
      limit ? parseInt(limit.toString(), 10) : 10,
    );
  }
}
