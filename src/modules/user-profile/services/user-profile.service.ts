import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../auth/entities/user.entity';
import { UpdateProfileDto } from '../dto/update-profile.dto';

@Injectable()
export class UserProfileService {
  private readonly logger = new Logger(UserProfileService.name);

  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
  ) {}

  /**
   * Récupère le profil d'un utilisateur
   * @param userId ID de l'utilisateur
   * @returns Les informations du profil utilisateur
   */
  async getProfile(userId: string): Promise<User> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('Utilisateur non trouvé');
    }

    // Ne pas renvoyer le mot de passe
    delete user.password;

    return user;
  }

  /**
   * Met à jour le profil d'un utilisateur
   * @param userId ID de l'utilisateur
   * @param updateProfileDto Données à mettre à jour
   * @returns Le profil utilisateur mis à jour
   */
  async updateProfile(userId: string, updateProfileDto: UpdateProfileDto): Promise<User> {
    const user = await this.getProfile(userId);

    try {
      // Mettre à jour les champs fournis
      if (updateProfileDto.first_name) user.first_name = updateProfileDto.first_name;
      if (updateProfileDto.last_name) user.last_name = updateProfileDto.last_name;
      if (updateProfileDto.username) user.username = updateProfileDto.username;
      if (updateProfileDto.email) user.email = updateProfileDto.email;
      if (updateProfileDto.phone_number) user.phone_number = updateProfileDto.phone_number;
      if (updateProfileDto.profile_picture) user.profile_picture = updateProfileDto.profile_picture;

      // Sauvegarder les modifications
      const updatedUser = await this.userRepository.save(user);
      
      // Ne pas renvoyer le mot de passe
      delete updatedUser.password;

      return updatedUser;
    } catch (error) {
      this.logger.error(`Erreur lors de la mise à jour du profil: ${error.message}`);
      
      // Gérer les erreurs de contrainte d'unicité
      if (error.message.includes('duplicate key value violates unique constraint')) {
        if (error.message.includes('username')) {
          throw new Error('Ce nom d\'utilisateur est déjà utilisé. Veuillez en choisir un autre.');
        } else if (error.message.includes('email')) {
          throw new Error('Cette adresse email est déjà utilisée. Veuillez en choisir une autre.');
        } else {
          throw new Error('Une valeur unique est déjà utilisée. Veuillez vérifier vos données.');
        }
      }
      
      // Relancer l'erreur pour les autres types d'erreurs
      throw error;
    }
  }

  /**
   * Supprime le compte d'un utilisateur
   * @param userId ID de l'utilisateur à supprimer
   */
  async deleteAccount(userId: string): Promise<void> {
    this.logger.log(`Tentative de suppression du compte utilisateur avec ID: ${userId}`);
    
    // Vérifier si l'utilisateur existe
    const user = await this.userRepository.findOne({
      where: { id: userId },
      relations: ['roles', 'addresses', 'notificationSettings', 'favorites'],
    });

    if (!user) {
      this.logger.error(`Utilisateur avec ID ${userId} non trouvé`);
      throw new NotFoundException('Utilisateur non trouvé');
    }

    // Utiliser une transaction pour garantir l'intégrité des données
    const queryRunner = this.userRepository.manager.connection.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // 1. Supprimer d'abord les relations de rôles (c'est la contrainte qui pose problème)
      this.logger.log(`Suppression des rôles associés à l'utilisateur ${userId}`);
      await queryRunner.manager.query(
        `DELETE FROM role_users_user WHERE "userId" = $1`,
        [userId]
      );

      // 2. Supprimer les adresses
      if (user.addresses && user.addresses.length > 0) {
        this.logger.log(`Suppression des adresses associées à l'utilisateur ${userId}`);
        await queryRunner.manager.query(
          `DELETE FROM user_addresses WHERE user_id = $1`,
          [userId]
        );
      }

      // 3. Supprimer les paramètres de notification
      if (user.notificationSettings) {
        this.logger.log(`Suppression des paramètres de notification associés à l'utilisateur ${userId}`);
        await queryRunner.manager.query(
          `DELETE FROM notification_settings WHERE user_id = $1`,
          [userId]
        );
      }

      // 4. Supprimer les favoris
      if (user.favorites && user.favorites.length > 0) {
        this.logger.log(`Suppression des favoris associés à l'utilisateur ${userId}`);
        await queryRunner.manager.query(
          `DELETE FROM user_favorites WHERE user_id = $1`,
          [userId]
        );
      }

      // 5. Enfin, supprimer l'utilisateur
      this.logger.log(`Suppression de l'utilisateur ${userId}`);
      await queryRunner.manager.query(
        `DELETE FROM users WHERE id = $1`,
        [userId]
      );
      
      // Valider la transaction
      await queryRunner.commitTransaction();
      this.logger.log(`Utilisateur ${userId} supprimé avec succès`);
    } catch (error) {
      // Annuler la transaction en cas d'erreur
      await queryRunner.rollbackTransaction();
      this.logger.error(`Erreur lors de la suppression de l'utilisateur ${userId}: ${error.message}`);
      throw new Error(`Impossible de supprimer l'utilisateur: ${error.message}`);
    } finally {
      // Libérer le queryRunner
      await queryRunner.release();
    }
  }
}
