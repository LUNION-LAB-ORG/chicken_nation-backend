import { Controller, Post, Body, Get, Param, Patch, Delete, UseGuards, Req } from '@nestjs/common';
import { CustomReportService } from '../services/custom-report.service';
import { CreateCustomReportDto } from '../dto/create-custom-report.dto';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { UserRole } from '../../auth/enums/user-role.enum';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam } from '@nestjs/swagger';
import { Request } from 'express';

@ApiTags('analytics/custom-reports')
@Controller('analytics/custom-reports')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class CustomReportController {
  constructor(private readonly customReportService: CustomReportService) {}

  @Post()
  @ApiOperation({ summary: 'Create a custom report' })
  @ApiResponse({ status: 201, description: 'Report created successfully.' })
  @ApiResponse({ status: 401, description: 'Unauthorized.' })
  async createReport(
    @Body() createReportDto: CreateCustomReportDto,
    @Req() req: Request,
  ) {
    const userId = req.user['id'];
    return this.customReportService.createReport(userId, createReportDto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all reports for current user' })
  @ApiResponse({ status: 200, description: 'Returns user\'s reports.' })
  @ApiResponse({ status: 401, description: 'Unauthorized.' })
  async getUserReports(@Req() req: Request) {
    const userId = req.user['id'];
    return this.customReportService.getUserReports(userId);
  }

  @Get('all')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Get all reports (admin only)' })
  @ApiResponse({ status: 200, description: 'Returns all reports.' })
  @ApiResponse({ status: 401, description: 'Unauthorized.' })
  @ApiResponse({ status: 403, description: 'Forbidden.' })
  async getAllReports() {
    // l'Admin peux voir tous les rapports
    return this.customReportService.getAllReports();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a report by ID' })
  @ApiResponse({ status: 200, description: 'Returns the report.' })
  @ApiResponse({ status: 401, description: 'Unauthorized.' })
  @ApiResponse({ status: 404, description: 'Report not found.' })
  @ApiParam({ name: 'id', description: 'Report ID' })
  async getReportById(@Param('id') id: string) {
    return this.customReportService.getReportById(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a report' })
  @ApiResponse({ status: 200, description: 'Report updated successfully.' })
  @ApiResponse({ status: 401, description: 'Unauthorized.' })
  @ApiResponse({ status: 404, description: 'Report not found.' })
  @ApiParam({ name: 'id', description: 'Report ID' })
  async updateReport(
    @Param('id') id: string,
    @Body() updateReportDto: Partial<CreateCustomReportDto>,
  ) {
    return this.customReportService.updateReport(id, updateReportDto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a report' })
  @ApiResponse({ status: 200, description: 'Report deleted successfully.' })
  @ApiResponse({ status: 401, description: 'Unauthorized.' })
  @ApiResponse({ status: 404, description: 'Report not found.' })
  @ApiParam({ name: 'id', description: 'Report ID' })
  async deleteReport(@Param('id') id: string) {
    await this.customReportService.deleteReport(id);
    return { message: 'Report deleted successfully' };
  }

  @Post(':id/generate')
  @ApiOperation({ summary: 'Generate a report' })
  @ApiResponse({ status: 200, description: 'Report generated successfully.' })
  @ApiResponse({ status: 401, description: 'Unauthorized.' })
  @ApiResponse({ status: 404, description: 'Report not found.' })
  @ApiParam({ name: 'id', description: 'Report ID' })
  async generateReport(@Param('id') id: string) {
    const filePath = await this.customReportService.generateReport(id);
    return { message: 'Report generated successfully', filePath };
  }
}
