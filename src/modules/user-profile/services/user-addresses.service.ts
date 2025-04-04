import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserAddress } from '../entities/user-address.entity';
import { CreateAddressDto } from '../dto/create-address.dto';

@Injectable()
export class UserAddressesService {
  private readonly logger = new Logger(UserAddressesService.name);

  constructor(
    @InjectRepository(UserAddress)
    private addressRepository: Repository<UserAddress>,
  ) {}

  /**
   * Récupère toutes les adresses d'un utilisateur
   * @param userId ID de l'utilisateur
   * @returns Liste des adresses de l'utilisateur
   */
  async getUserAddresses(userId: string): Promise<UserAddress[]> {
    return this.addressRepository.find({
      where: { userId },
      order: { isDefault: 'DESC' },
    });
  }

  /**
   * Récupère une adresse spécifique d'un utilisateur
   * @param userId ID de l'utilisateur
   * @param addressId ID de l'adresse
   * @returns L'adresse demandée
   */
  async getUserAddress(userId: string, addressId: string): Promise<UserAddress> {
    const address = await this.addressRepository.findOne({
      where: { id: addressId, userId },
    });

    if (!address) {
      throw new NotFoundException('Adresse non trouvée');
    }

    return address;
  }

  /**
   * Crée une nouvelle adresse pour un utilisateur
   * @param userId ID de l'utilisateur
   * @param createAddressDto Données de la nouvelle adresse
   * @returns L'adresse créée
   */
  async createAddress(userId: string, createAddressDto: CreateAddressDto): Promise<UserAddress> {
    // Si la nouvelle adresse est définie comme par défaut, réinitialiser les autres
    if (createAddressDto.isDefault) {
      await this.resetDefaultAddresses(userId);
    }

    const newAddress = this.addressRepository.create({
      userId,
      name: createAddressDto.name,
      address: createAddressDto.address,
      details: createAddressDto.details,
      latitude: createAddressDto.latitude,
      longitude: createAddressDto.longitude,
      isDefault: createAddressDto.isDefault || false,
    });

    return this.addressRepository.save(newAddress);
  }

  /**
   * Met à jour une adresse existante
   * @param userId ID de l'utilisateur
   * @param addressId ID de l'adresse
   * @param updateData Données à mettre à jour
   * @returns L'adresse mise à jour
   */
  async updateAddress(userId: string, addressId: string, updateData: CreateAddressDto): Promise<UserAddress> {
    const address = await this.getUserAddress(userId, addressId);

    // Si l'adresse est définie comme par défaut, réinitialiser les autres
    if (updateData.isDefault && !address.isDefault) {
      await this.resetDefaultAddresses(userId);
    }

    // Mettre à jour les champs
    address.name = updateData.name || address.name;
    address.address = updateData.address || address.address;
    address.details = updateData.details !== undefined ? updateData.details : address.details;
    address.latitude = updateData.latitude !== undefined ? updateData.latitude : address.latitude;
    address.longitude = updateData.longitude !== undefined ? updateData.longitude : address.longitude;
    address.isDefault = updateData.isDefault !== undefined ? updateData.isDefault : address.isDefault;

    return this.addressRepository.save(address);
  }

  /**
   * Supprime une adresse
   * @param userId ID de l'utilisateur
   * @param addressId ID de l'adresse
   * @returns Message de confirmation
   */
  async deleteAddress(userId: string, addressId: string): Promise<{ message: string }> {
    const address = await this.getUserAddress(userId, addressId);
    await this.addressRepository.remove(address);
    return { message: 'Adresse supprimée avec succès' };
  }

  /**
   * Réinitialise toutes les adresses par défaut d'un utilisateur
   * @param userId ID de l'utilisateur
   */
  private async resetDefaultAddresses(userId: string): Promise<void> {
    await this.addressRepository.update(
      { userId, isDefault: true },
      { isDefault: false }
    );
  }
}
