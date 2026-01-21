import { CacheInterceptor } from '@nestjs/cache-manager';
import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtCustomerAuthGuard } from 'src/modules/auth/guards/jwt-customer-auth.guard';
import { CreateCardRequestDto } from '../dtos/create-card-request.dto';
import { CardRequestService } from '../services/card-request.service';

@ApiTags('Carte Nation - Client')
@ApiBearerAuth()
@Controller('card-nation')
@UseInterceptors(CacheInterceptor)
export class CardRequestController {
  constructor(private readonly cardRequestService: CardRequestService) { }

  /**
   * Créer une demande de carte Nation
   */
  @Post('request')
  @UseGuards(JwtCustomerAuthGuard)
  @ApiOperation({ summary: 'Soumettre une demande de carte Nation' })
  async createRequest(
    @Req() req: Request,
    @Body() createDto: CreateCardRequestDto,
  ) {
    const customerId = (req as any).user.id;

    return this.cardRequestService.createRequest(customerId, {
      ...createDto
    });
  }
  /**
   * Créer une demande de carte Nation
   */
  @Post('verify-request')
  @UseGuards(JwtCustomerAuthGuard)
  @UseInterceptors(FileInterceptor('image'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Vérifier une demande de carte Nation' })
  async verifyRequest(
    @Req() req: Request,
    @UploadedFile() file: Express.Multer.File,
  ) {
    const customerId = (req as any).user.id;

    return this.cardRequestService.verifyRequest(customerId, file);
  }

  /**
   * Obtenir ma demande de carte
   */
  @Get('my-request')
  @UseGuards(JwtCustomerAuthGuard)
  @ApiOperation({ summary: 'Récupérer ma demande de carte Nation' })
  async getMyRequest(@Req() req: Request) {
    const customerId = (req as any).user.id;
    return this.cardRequestService.getMyRequest(customerId);
  }

  /**
   * Obtenir ma carte Nation
   */
  @Get('my-card')
  @UseGuards(JwtCustomerAuthGuard)
  @ApiOperation({ summary: 'Récupérer ma carte Nation' })
  async getMyCard(@Req() req: Request) {
    const customerId = (req as any).user.id;
    return this.cardRequestService.getMyCard(customerId);
  }
}