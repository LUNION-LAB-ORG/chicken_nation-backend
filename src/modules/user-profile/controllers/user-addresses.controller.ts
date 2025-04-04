import { Controller, Get, Post, Put, Delete, UseGuards, Request, Body, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { UserAddressesService } from '../services/user-addresses.service';
import { CreateAddressDto } from '../dto/create-address.dto';

@ApiTags('user-addresses')
@Controller('user-profile/addresses')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class UserAddressesController {
  constructor(private readonly userAddressesService: UserAddressesService) {}

  @Get()
  @ApiOperation({ summary: 'Récupérer toutes les adresses de l\'utilisateur' })
  @ApiResponse({ status: 200, description: 'Adresses récupérées avec succès' })
  @ApiResponse({ status: 401, description: 'Non autorisé' })
  async getUserAddresses(@Request() req) {
    return this.userAddressesService.getUserAddresses(req.user.userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Récupérer une adresse spécifique' })
  @ApiResponse({ status: 200, description: 'Adresse récupérée avec succès' })
  @ApiResponse({ status: 401, description: 'Non autorisé' })
  @ApiResponse({ status: 404, description: 'Adresse non trouvée' })
  async getUserAddress(@Request() req, @Param('id') addressId: string) {
    return this.userAddressesService.getUserAddress(req.user.userId, addressId);
  }

  @Post()
  @ApiOperation({ summary: 'Ajouter une nouvelle adresse' })
  @ApiResponse({ status: 201, description: 'Adresse créée avec succès' })
  @ApiResponse({ status: 401, description: 'Non autorisé' })
  async createAddress(@Request() req, @Body() createAddressDto: CreateAddressDto) {
    return this.userAddressesService.createAddress(req.user.userId, createAddressDto);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Mettre à jour une adresse' })
  @ApiResponse({ status: 200, description: 'Adresse mise à jour avec succès' })
  @ApiResponse({ status: 401, description: 'Non autorisé' })
  @ApiResponse({ status: 404, description: 'Adresse non trouvée' })
  async updateAddress(
    @Request() req,
    @Param('id') addressId: string,
    @Body() updateAddressDto: CreateAddressDto,
  ) {
    return this.userAddressesService.updateAddress(req.user.userId, addressId, updateAddressDto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Supprimer une adresse' })
  @ApiResponse({ status: 200, description: 'Adresse supprimée avec succès' })
  @ApiResponse({ status: 401, description: 'Non autorisé' })
  @ApiResponse({ status: 404, description: 'Adresse non trouvée' })
  async deleteAddress(@Request() req, @Param('id') addressId: string) {
    return this.userAddressesService.deleteAddress(req.user.userId, addressId);
  }
}
