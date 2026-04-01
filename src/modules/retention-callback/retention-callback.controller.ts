import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { RetentionCallbackService } from './retention-callback.service';
import { CreateRetentionCallbackDto } from './dto/create-retention-callback.dto';
import { UpdateRetentionCallbackDto } from './dto/update-retention-callback.dto';
import { QueryRetentionCallbackDto } from './dto/query-retention-callback.dto';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { Type } from 'class-transformer';
import { IsNumber, IsOptional, Min } from 'class-validator';

class TrendQueryDto {
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  days?: number = 30;
}

class StatsDateFilterDto {
  @IsOptional()
  dateFrom?: string;

  @IsOptional()
  dateTo?: string;
}

@Controller('retention-callback')
@UseGuards(JwtAuthGuard)
export class RetentionCallbackController {
  constructor(private readonly callbackService: RetentionCallbackService) {}

  // === CALLBACKS CRUD ===

  @Get()
  findAll(@Query() query: QueryRetentionCallbackDto) {
    return this.callbackService.findAll(query);
  }

  @Get('due')
  findDue() {
    return this.callbackService.findDue();
  }

  @Get('called-customers')
  getCalledCustomerIds() {
    return this.callbackService.getCalledCustomerIds();
  }

  @Get('customer/:customerId')
  findByCustomer(@Param('customerId') customerId: string) {
    return this.callbackService.findByCustomer(customerId);
  }

  // === STATS ===

  @Get('stats/overview')
  getOverview(@Query() query: StatsDateFilterDto) {
    return this.callbackService.getOverview(query.dateFrom, query.dateTo);
  }

  @Get('stats/by-reason')
  getByReason(@Query() query: StatsDateFilterDto) {
    return this.callbackService.getByReason(query.dateFrom, query.dateTo);
  }

  @Get('stats/agent-performance')
  getAgentPerformance(@Query() query: StatsDateFilterDto) {
    return this.callbackService.getAgentPerformance(query.dateFrom, query.dateTo);
  }

  @Get('stats/funnel')
  getFunnel(@Query() query: StatsDateFilterDto) {
    return this.callbackService.getFunnel(query.dateFrom, query.dateTo);
  }

  @Get('stats/trend')
  getTrend(@Query() query: TrendQueryDto & StatsDateFilterDto) {
    return this.callbackService.getTrend(query.days, query.dateFrom, query.dateTo);
  }

  // === CRUD (must be after all specific routes) ===

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.callbackService.findOne(id);
  }

  @Post()
  create(@Req() req, @Body() dto: CreateRetentionCallbackDto) {
    return this.callbackService.create(dto, req.user.id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateRetentionCallbackDto) {
    return this.callbackService.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.callbackService.remove(id);
  }
}
