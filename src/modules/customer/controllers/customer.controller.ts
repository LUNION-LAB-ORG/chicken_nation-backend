import { Controller, Query, Get, Post, Body, Patch, Param, Delete, Req, UseGuards, UseInterceptors, UploadedFile } from '@nestjs/common';
import { CustomerService } from 'src/modules/customer/services/customer.service';
import { CreateCustomerDto } from 'src/modules/customer/dto/create-customer.dto';
import { UpdateCustomerDto } from 'src/modules/customer/dto/update-customer.dto';
import { Request } from 'express';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { CustomerQueryDto } from 'src/modules/customer/dto/customer-query.dto';
import { GenerateConfigService } from 'src/common/services/generate-config.service';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtCustomerAuthGuard } from 'src/modules/auth/guards/jwt-customer-auth.guard';

@ApiTags('Customers')
@ApiBearerAuth()
@Controller('customer')
export class CustomerController {
  constructor(private readonly customerService: CustomerService) { }


  // CREATE CUSTOMER
  @Post()
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('image', { ...GenerateConfigService.generateConfigSingleImageUpload('./uploads/customer-avatar') }))
  @ApiOperation({ summary: 'Création d\'un nouveau client' })
  async create(@Body() createCustomerDto: CreateCustomerDto, @UploadedFile() image: Express.Multer.File) {
    const resizedPath = await GenerateConfigService.compressImages(
      { "img_1": image?.path },
      undefined,
      {
        quality: 70,
        width: 600,
        fit: 'inside',
      },
      true,
    );
    return this.customerService.create({ ...createCustomerDto, image: resizedPath!["img_1"] ?? image?.path });
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Récupération de tous les clients' })
  findAll(@Query() query: CustomerQueryDto) {
    return this.customerService.findAll(query);
  }

  @Get('/detail')
  @UseGuards(JwtCustomerAuthGuard)
  @ApiOperation({ summary: 'Obtenir le détail d un client' })
  detail(@Req() req: Request) {
    return this.customerService.detail(req);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Obtenir un client par ID' })
  findOne(@Param('id') id: string) {
    return this.customerService.findOne(id);
  }

  @Patch()
  @UseGuards(JwtCustomerAuthGuard)
  @UseInterceptors(FileInterceptor('image', { ...GenerateConfigService.generateConfigSingleImageUpload('./uploads/customer-avatar') }))
  @ApiOperation({ summary: 'Mettre à jour un client' })
  async update(@Req() req: Request, @Body() updateCustomerDto: UpdateCustomerDto, @UploadedFile() image: Express.Multer.File) {
    const resizedPath = await GenerateConfigService.compressImages(
      { "img_1": image?.path },
      undefined,
      {
        quality: 70,
        width: 600,
        fit: 'inside',
      },
      true,
    );
    return this.customerService.update(req, { ...updateCustomerDto, image: resizedPath!["img_1"] ?? image?.path });
  }

  @Get('phone/:phone')
  @ApiOperation({ summary: 'Obtenir un client par numéro de téléphone' })
  findByPhone(@Param('phone') phone: string) {
    return this.customerService.findByPhone(phone);
  }

  @Delete(':id')
  @UseGuards(JwtCustomerAuthGuard)
  @ApiOperation({ summary: 'Supprimer un client' })
  remove(@Param('id') id: string) {
    return this.customerService.remove(id);
  }
}
