import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { RetentionCallbackReasonService } from './retention-callback-reason.service';
import { CreateReasonDto } from './dto/create-reason.dto';
import { UpdateReasonDto } from './dto/update-reason.dto';
import { ReorderReasonsDto } from './dto/reorder-reasons.dto';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';

@Controller('retention-callback/reasons')
@UseGuards(JwtAuthGuard)
export class RetentionCallbackReasonController {
  constructor(private readonly reasonService: RetentionCallbackReasonService) {}

  @Get()
  findAll() {
    return this.reasonService.findAll();
  }

  @Post()
  create(@Body() dto: CreateReasonDto) {
    return this.reasonService.create(dto);
  }

  @Patch('reorder')
  reorder(@Body() dto: ReorderReasonsDto) {
    return this.reasonService.reorder(dto.ids);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateReasonDto) {
    return this.reasonService.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.reasonService.remove(id);
  }
}
