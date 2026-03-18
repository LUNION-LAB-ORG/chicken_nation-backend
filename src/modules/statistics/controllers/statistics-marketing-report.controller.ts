import {
  Controller,
  Get,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { MarketingReportService, MarketingReportQuery } from '../services/marketing-report.service';
import { IsOptional, IsString, IsIn, IsDateString, IsUUID, IsBooleanString } from 'class-validator';
import { Transform } from 'class-transformer';

export class MarketingReportQueryDto {
  @IsUUID()
  @IsOptional()
  restaurantId?: string;

  @IsDateString()
  @IsOptional()
  startDate?: string;

  @IsDateString()
  @IsOptional()
  endDate?: string;

  @IsIn(['today', 'week', 'month', 'last_month', 'year'])
  @IsOptional()
  period?: 'today' | 'week' | 'month' | 'last_month' | 'year';

  @IsIn(['DELIVERY', 'PICKUP', 'TABLE'])
  @IsOptional()
  type?: any;

  @IsIn(['PENDING', 'ACCEPTED', 'IN_PROGRESS', 'READY', 'PICKED_UP', 'COLLECTED', 'COMPLETED', 'CANCELLED'])
  @IsOptional()
  status?: any;

  @IsBooleanString()
  @IsOptional()
  @Transform(({ value }) => value === 'true' ? true : value === 'false' ? false : undefined)
  auto?: boolean;
}

@Controller('statistics/marketing')
@UseGuards(JwtAuthGuard, UserPermissionsGuard)
export class StatisticsMarketingReportController {
  constructor(private readonly reportService: MarketingReportService) {}

  @Get('export-report-pdf')
  @RequirePermission(Modules.DASHBOARD, Action.READ)
  async exportReportPdf(
    @Query() query: MarketingReportQueryDto,
    @Res() res: Response,
  ) {
    const { buffer, filename } = await this.reportService.generatePdf(query);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': buffer.length,
    });

    res.end(buffer);
  }
}
