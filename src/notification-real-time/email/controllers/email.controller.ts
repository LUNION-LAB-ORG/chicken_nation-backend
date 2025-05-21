import { Body, Controller, Post } from '@nestjs/common';
import { EmailService } from '../services/email.service';
import { sendEmailDto } from '../dto/sendEmailDto';

@Controller('email')
export class EmailController {
  constructor(private readonly emailService: EmailService) { }

  @Post('send')
  async sendEmail(@Body() data: sendEmailDto) {
    try {
      await this.emailService.sendEmail(data);
      return {
        message: 'Email sent successfully',
      };
    } catch (error: any) {
      return {
        message: 'Error sending mail',
        error: error
      };
    }
  }
}
