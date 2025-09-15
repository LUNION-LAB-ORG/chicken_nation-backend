import {
  Body,
  Controller,
  Get,
  Logger,
  Param,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { MessageService } from '../services/message.service';
import { QueryMessagesDto } from '../dto/query-messages.dto';
import { Request } from 'express';
import { CreateMessageDto } from '../dto/createMessageDto';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { JwtCustomerAuthGuard } from '../../auth/guards/jwt-customer-auth.guard';
import { FileInterceptor } from '@nestjs/platform-express';
import { GenerateConfigService } from 'src/common/services/generate-config.service';
import { Customer, User } from '@prisma/client';

@Controller('conversations/:conversationId/messages')
export class MessageController {
  private readonly logger = new Logger(MessageController.name);
  private readonly isDev = process.env.NODE_ENV !== 'production';
  constructor(private readonly messageService: MessageService) { }

  @UseGuards(JwtAuthGuard)
  @Get()
  async getMessages(
    @Req() req: Request,
    @Param('conversationId') conversationId: string,
    @Query() filter: QueryMessagesDto = {},
  ) {
    return await this.messageService.getMessages(req, conversationId, filter);
  }

  @UseGuards(JwtCustomerAuthGuard)
  @Get('/client')
  async getMessagesClient(
    @Req() req: Request,
    @Param('conversationId') conversationId: string,
    @Query() filter: QueryMessagesDto = {},
  ) {
    return await this.messageService.getMessages(req, conversationId, filter);
  }

  @UseGuards(JwtAuthGuard) @Post()
  @UseInterceptors(FileInterceptor('imageUrl', { ...GenerateConfigService.generateConfigSingleImageUpload('./uploads/messagerie') }))
  async createMessage(
    @Req() req: Request,
    @Param('conversationId') conversationId: string,
    @Body() createMessageDto: CreateMessageDto,
    @UploadedFile() image: Express.Multer.File,
  ) {
    return this.handleCreateMessage(req, conversationId, createMessageDto, image);
  }

  @UseGuards(JwtCustomerAuthGuard) @Post('/client')
  @UseInterceptors(FileInterceptor('imageUrl', { ...GenerateConfigService.generateConfigSingleImageUpload('./uploads/messagerie') }))
  async createMessageClient(
    @Req() req: Request,
    @Param('conversationId') conversationId: string,
    @Body() createMessageDto: CreateMessageDto,
    @UploadedFile() image?: Express.Multer.File, // image peut être undefined ici
  ) {
    return this.handleCreateMessage(req, conversationId, createMessageDto, image);
  }

  @UseGuards(JwtAuthGuard)
  @Post('messages/read')
  async markMessagesAsRead(@Req() req: Request, @Param('ticketId') ticketId: string) {
    return this.messageService.markMessagesAsRead(ticketId, "USER", (req.user as User).id);
  }

  @UseGuards(JwtCustomerAuthGuard)
  @Post('customer/messages/read')
  async markCustomerMessagesAsRead(@Req() req: Request, @Param('ticketId') ticketId: string) {
    return this.messageService.markMessagesAsRead(ticketId, "CUSTOMER", (req.user as Customer).id);
  }

  private async handleCreateMessage(
    req: Request,
    conversationId: string,
    createMessageDto: CreateMessageDto,
    image?: Express.Multer.File,
  ) {
    if (this.isDev) {
      this.logger.debug(`Requête de création de message reçue: ${JSON.stringify(createMessageDto)}`);
      if (image) {
        this.logger.debug(`Image reçue: ${JSON.stringify(image)}`);
      }
    }

    let imageUrl: string | undefined = undefined;
    if (image) {
      const resizedPath = await GenerateConfigService.compressImages(
        { "img_1": image.path },
        undefined,
        { quality: 70 },
        true,
      );
      if (this.isDev) {
        this.logger.debug(`Chemin de l'image redimensionnée: ${JSON.stringify(resizedPath)}`);
      }
      imageUrl = resizedPath["img_1"] ?? image.path;
    }

    return await this.messageService.createMessage(
      req,
      conversationId,
      { ...createMessageDto, imageUrl }
    );
  }
}
