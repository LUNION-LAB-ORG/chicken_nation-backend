import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CustomReport, ReportFormat, ReportType } from '../entities/custom-report.entity';
import { CreateCustomReportDto } from '../dto/create-custom-report.dto';
import * as fs from 'fs';
import * as path from 'path';
import { createObjectCsvWriter } from 'csv-writer';
import { SalesStatisticsService } from './sales-statistics.service';

@Injectable()
export class CustomReportService {
  constructor(
    @InjectRepository(CustomReport)
    private customReportRepository: Repository<CustomReport>,
    private salesStatisticsService: SalesStatisticsService,
  ) {}

  async createReport(userId: string, createReportDto: CreateCustomReportDto): Promise<CustomReport> {
    const report = this.customReportRepository.create({
      ...createReportDto,
      userId,
    });

    return this.customReportRepository.save(report);
  }

  async getReportById(id: string): Promise<CustomReport> {
    const report = await this.customReportRepository.findOne({ where: { id } });
    if (!report) {
      throw new NotFoundException(`Report with ID ${id} not found`);
    }
    return report;
  }

  async getUserReports(userId: string): Promise<CustomReport[]> {
    return this.customReportRepository.find({ where: { userId } });
  }

  async updateReport(id: string, updateReportDto: Partial<CreateCustomReportDto>): Promise<CustomReport> {
    const report = await this.getReportById(id);
    Object.assign(report, updateReportDto);
    return this.customReportRepository.save(report);
  }

  async deleteReport(id: string): Promise<void> {
    const report = await this.getReportById(id);
    await this.customReportRepository.remove(report);
  }

  async generateReport(reportId: string): Promise<string> {
    const report = await this.getReportById(reportId);
    
    // Get data based on report type and filters
    const data = await this.getReportData(report);
    
    // Generate file based on format
    const filePath = await this.exportData(data, report);
    
    // Update report with file path and last run info
    report.filePath = filePath;
    report.lastRunAt = new Date();
    report.lastRunStatus = 'success';
    await this.customReportRepository.save(report);
    
    return filePath;
  }

  private async getReportData(report: CustomReport): Promise<any[]> {
    const { reportType, filters } = report;
    
    // Parse dates from filters
    const startDate = filters.startDate ? new Date(filters.startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // Default to last 30 days
    const endDate = filters.endDate ? new Date(filters.endDate) : new Date();
    
    switch (reportType) {
      case ReportType.SALES:
        // Get sales statistics
        const salesStats = await this.salesStatisticsService.getStatistics({
          periodType: filters.periodType || 'daily',
          startDate: filters.startDate,
          endDate: filters.endDate,
          restaurantId: filters.restaurantId,
          categoryId: filters.categoryId,
          productId: filters.productId,
        });
        return salesStats;
        
      case ReportType.PRODUCTS:
        // Get top products
        return this.salesStatisticsService.getTopProducts(startDate, endDate, filters.limit || 10);
        
      case ReportType.RESTAURANTS:
        // Get top restaurants
        return this.salesStatisticsService.getTopRestaurants(startDate, endDate, filters.limit || 10);
        
      // Add more cases for other report types
        
      default:
        throw new BadRequestException(`Report type ${reportType} not supported`);
    }
  }

  private async exportData(data: any[], report: CustomReport): Promise<string> {
    const { format, name } = report;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `${name.replace(/\s+/g, '_')}_${timestamp}`;
    const reportsDir = path.join(process.cwd(), 'reports');
    
    // Ensure reports directory exists
    if (!fs.existsSync(reportsDir)) {
      fs.mkdirSync(reportsDir, { recursive: true });
    }
    
    switch (format) {
      case ReportFormat.CSV:
        return this.exportToCsv(data, fileName, reportsDir, report.columns);
        
      case ReportFormat.JSON:
        return this.exportToJson(data, fileName, reportsDir);
        
      // Add more cases for other formats
        
      default:
        throw new BadRequestException(`Format ${format} not supported`);
    }
  }

  private async exportToCsv(data: any[], fileName: string, dir: string, columns: string[]): Promise<string> {
    const filePath = path.join(dir, `${fileName}.csv`);
    
    // Create CSV writer
    const csvWriter = createObjectCsvWriter({
      path: filePath,
      header: columns.map(column => ({ id: column, title: column })),
    });
    
    // Write data to CSV
    await csvWriter.writeRecords(data);
    
    return filePath;
  }

  private async exportToJson(data: any[], fileName: string, dir: string): Promise<string> {
    const filePath = path.join(dir, `${fileName}.json`);
    
    // Write data to JSON file
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    
    return filePath;
  }

  async scheduleReports(): Promise<void> {
    // This would be called by a scheduler to generate scheduled reports
    const scheduledReports = await this.customReportRepository.find({
      where: { isScheduled: true },
    });
    
    for (const report of scheduledReports) {
      try {
        await this.generateReport(report.id);
      } catch (error) {
        // Log error and update report status
        report.lastRunStatus = 'error';
        await this.customReportRepository.save(report);
      }
    }
  }

  /**
   * Récupère tous les rapports personnalisés
   * @returns Tous les rapports personnalisés
   */
  async getAllReports() {
    return this.customReportRepository.find({
      relations: ['user'],
    });
  }
}
