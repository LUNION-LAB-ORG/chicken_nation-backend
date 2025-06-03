import { Controller, Post, Body, Inject } from '@nestjs/common';
import { sendEmailDto } from '../dto/sendEmailDto';
import { IEmailService } from '../interfaces/email-service.interface';
import { ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('Email')
@Controller('email')
export class EmailController {
  constructor(
    @Inject('EMAIL_SERVICE') private readonly emailService: IEmailService,
  ) { }

  @ApiOperation({ summary: 'Envoi un email' })
  @Post('send')
  async sendEmail(@Body() dto: sendEmailDto): Promise<{ success: boolean }> {
    await this.emailService.sendEmail(dto);
    return { success: true };
  }
}