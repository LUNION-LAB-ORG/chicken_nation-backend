import { Controller, Get, Post, Body, Patch, Param, Delete, Query, UseGuards, Req, UseInterceptors, UploadedFile } from '@nestjs/common';
import { PromotionService } from '../services/promotion.service';
import { CreatePromotionDto } from '../dto/create-promotion.dto';
import { UpdatePromotionDto } from '../dto/update-promotion.dto';
import { ApiOperation, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { PromotionResponseDto } from '../dto/promotion-response.dto';
import { Request } from 'express';
import { Customer, LoyaltyLevel, User } from '@prisma/client';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { QueryPromotionDto } from '../dto/query-promotion.dto';
import { UserTypesGuard } from 'src/common/guards/user-types.guard';
import { UserTypes } from 'src/common/decorators/user-types.decorator';
import { UserType } from '@prisma/client';
import { QueryResponseDto } from 'src/common/dto/query-response.dto';
import { ApplyDiscountPromotionDtoResponse, ApplyItemDto } from '../dto/apply-discount-promotion.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { GenerateConfigService } from 'src/common/services/generate-config.service';

@ApiTags('Promotions')
@Controller('fidelity/promotions')

export class PromotionController {
  constructor(private readonly promotionService: PromotionService) { }

  @ApiOperation({ summary: 'Créer une promotion' })
  @ApiOkResponse({ type: PromotionResponseDto })
  @UseGuards(JwtAuthGuard, UserTypesGuard)
  @UseInterceptors(FileInterceptor('coupon_image_url', { ...GenerateConfigService.generateConfigSingleImageUpload('./uploads/promotions') }))
  @UserTypes(UserType.BACKOFFICE)
  @Post()
  async create(@Req() req: Request, @Body() createPromotionDto: CreatePromotionDto, @UploadedFile() image: Express.Multer.File) {
    const user = req.user as User;

    const resizedPath = await GenerateConfigService.compressImages(
      { "img_1": image?.path },
      undefined,
      {
        quality: 70,
      },
      true,
    );
    return this.promotionService.create({ ...createPromotionDto, coupon_image_url: resizedPath!["img_1"] ?? image?.path }, user.id);
  }

  @ApiOperation({ summary: 'Lister les promotions' })
  @ApiOkResponse({ type: QueryResponseDto })
  @Get()
  findAll(@Query() filters: QueryPromotionDto) {
    return this.promotionService.findAll(filters);
  }

  @ApiOperation({ summary: 'Obtenir une promotion par ID' })
  @ApiOkResponse({ type: PromotionResponseDto })
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.promotionService.findOne(id);
  }

  @ApiOperation({ summary: 'Mettre à jour une promotion' })
  @ApiOkResponse({ type: PromotionResponseDto })
  @UseInterceptors(FileInterceptor('coupon_image_url', { ...GenerateConfigService.generateConfigSingleImageUpload('./uploads/promotions') }))
  @UseGuards(JwtAuthGuard, UserTypesGuard)
  @UserTypes(UserType.BACKOFFICE)
  @Patch(':id')
  async update(@Param('id') id: string, @Body() updatePromotionDto: UpdatePromotionDto, @UploadedFile() image: Express.Multer.File) {
    const resizedPath = await GenerateConfigService.compressImages(
      { "img_1": image?.path },
      undefined,
      {
        quality: 70,
      },
      true,
    );
    return this.promotionService.update(id, { ...updatePromotionDto, coupon_image_url: resizedPath!["img_1"] ?? image?.path });
  }

  @ApiOperation({ summary: 'Supprimer une promotion' })
  @ApiOkResponse({ type: PromotionResponseDto })
  @UseGuards(JwtAuthGuard, UserTypesGuard)
  @UserTypes(UserType.BACKOFFICE)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.promotionService.remove(id);
  }

  @ApiOperation({ summary: 'Calculer le remise d\'une promotion' })
  @ApiOkResponse({ type: ApplyDiscountPromotionDtoResponse })
  @Post(':id/calculate-discount')
  calculateDiscount(
    @Req() req: Request,
    @Param('id') promotion_id: string,
    @Query('order_amount') order_amount: number,
    @Query('loyalty_level') loyalty_level: LoyaltyLevel,
    @Body() items: ApplyItemDto[]
  ) {
    const customer = req.user as Customer;
    return this.promotionService.calculateDiscount(promotion_id, order_amount, customer.id, items, loyalty_level);
  }

  @ApiOperation({ summary: 'Vérifier si un plat est dans une promotion' })
  @ApiOkResponse({ type: PromotionResponseDto })
  @Get('dish/:dishId/check')
  checkDishPromotion(
    @Param('dishId') dishId: string,
    @Query('loyaltyLevel') loyaltyLevel?: string
  ) {
    return this.promotionService.isDishInPromotion(dishId, loyaltyLevel as any);
  }
}