import { Body, Controller, Delete, Get, Logger, Param, Patch, Post, Query, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Customer, LoyaltyLevel, User } from '@prisma/client';
import { Request } from 'express';
import { QueryResponseDto } from 'src/common/dto/query-response.dto';
import { GenerateConfigService } from 'src/common/services/generate-config.service';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { JwtCustomerAuthGuard } from 'src/modules/auth/guards/jwt-customer-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { ApplyDiscountPromotionDtoResponse, ApplyItemDto } from '../dto/apply-discount-promotion.dto';
import { CreatePromotionDto } from '../dto/create-promotion.dto';
import { PromotionResponseDto } from '../dto/promotion-response.dto';
import { QueryPromotionDto } from '../dto/query-promotion.dto';
import { UpdatePromotionDto } from '../dto/update-promotion.dto';
import { PromotionService } from '../services/promotion.service';

@ApiTags('Promotions')
@Controller('fidelity/promotions')

export class PromotionController {
  private readonly logger = new Logger(PromotionController.name);
  constructor(private readonly promotionService: PromotionService) { }

  @Post()
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.PROMOTIONS, Action.CREATE)
  @ApiOperation({ summary: 'Créer une promotion' })
  @ApiOkResponse({ type: PromotionResponseDto })
  @UseInterceptors(FileInterceptor('coupon_image_url', { ...GenerateConfigService.generateConfigSingleImageUpload('./uploads/promotions') }))
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
    return this.promotionService.create(req, { ...createPromotionDto, coupon_image_url: resizedPath!["img_1"] ?? image?.path }, user.id);
  }

  @Get()
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.PROMOTIONS, Action.READ)
  @ApiOperation({ summary: 'Lister les promotions' })
  @ApiOkResponse({ type: QueryResponseDto })
  findAll(@Query() filters: QueryPromotionDto) {
    return this.promotionService.findAll(filters);
  }

  @Get('customer')
  @ApiOperation({ summary: 'Lister les promotions pour un client' })
  @ApiOkResponse({ type: QueryResponseDto })
  @UseGuards(JwtCustomerAuthGuard)
  findAllForCustomer(@Req() req: Request, @Query() filters: QueryPromotionDto) {
    return this.promotionService.findAllForCustomer(req, filters);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtenir une promotion par ID' })
  @ApiOkResponse({ type: PromotionResponseDto })
  findOne(@Param('id') id: string) {
    return this.promotionService.findOne(id);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.PROMOTIONS, Action.UPDATE)
  @ApiOperation({ summary: 'Mettre à jour une promotion' })
  @ApiOkResponse({ type: PromotionResponseDto })
  @UseInterceptors(FileInterceptor('coupon_image_url', { ...GenerateConfigService.generateConfigSingleImageUpload('./uploads/promotions') }))
  async update(@Req() req: Request, @Param('id') id: string, @Body() updatePromotionDto: UpdatePromotionDto, @UploadedFile() image: Express.Multer.File) {
    const resizedPath = await GenerateConfigService.compressImages(
      { "img_1": image?.path },
      undefined,
      {
        quality: 70,
      },
      true,
    );
    return this.promotionService.update(req, id, { ...updatePromotionDto, coupon_image_url: resizedPath!["img_1"] ?? image?.path });
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.PROMOTIONS, Action.DELETE)
  @ApiOperation({ summary: 'Supprimer une promotion' })
  @ApiOkResponse({ type: PromotionResponseDto })
  remove(@Req() req: Request, @Param('id') id: string) {
    return this.promotionService.remove(req, id);
  }

  @Post(':id/calculate-discount')
  @UseGuards(JwtCustomerAuthGuard)
  @ApiOperation({ summary: 'Calculer le remise d\'une promotion' })
  @ApiOkResponse({ type: ApplyDiscountPromotionDtoResponse })
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

  @Post(':id/can-use')
  @UseGuards(JwtCustomerAuthGuard)
  @ApiOperation({ summary: 'Vérifier si un client peut utiliser une promotion' })
  @ApiOkResponse({ type: ApplyDiscountPromotionDtoResponse })
  canCustomerUsePromotion(
    @Req() req: Request,
    @Param('id') promotion_id: string,
  ) {
    const customer = req.user as Customer;
    return this.promotionService.canCustomerUsePromotion(promotion_id, customer.id);
  }

  @Get('dish/:dishId/check')
  @ApiOperation({ summary: 'Vérifier si un plat est dans une promotion' })
  @ApiOkResponse({ type: PromotionResponseDto })
  checkDishPromotion(
    @Param('dishId') dishId: string,
    @Query('loyaltyLevel') loyaltyLevel?: string
  ) {
    return this.promotionService.isDishInPromotion(dishId, loyaltyLevel as any);
  }
}