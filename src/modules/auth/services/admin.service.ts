import { Injectable, NotFoundException, Logger, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { User } from '../entities/user.entity';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private dataSource: DataSource,
  ) {}

  /**
   * Supprime un utilisateur par son ID
   * @param userId ID de l'utilisateur à supprimer
   * @param forceDelete Si true, permet de supprimer un administrateur (sauf super-admin)
   */
  async deleteUser(userId: string, forceDelete: boolean = false): Promise<void> {
    this.logger.log(`Tentative de suppression de l'utilisateur avec ID: ${userId}`);
    
    // Vérifier si l'utilisateur existe
    const user = await this.userRepository.findOne({
      where: { id: userId },
      relations: ['roles', 'addresses', 'notificationSettings', 'favorites'],
    });

    if (!user) {
      this.logger.error(`Utilisateur avec ID ${userId} non trouvé`);
      throw new NotFoundException('Utilisateur non trouvé');
    }

    // Vérifier si l'utilisateur est un administrateur ou un manager
    const isAdmin = user.roles.some(role => role.name === 'admin');
    const isManager = user.roles.some(role => role.name === 'manager');
    
    // Si c'est un admin ou un manager et qu'on n'a pas explicitement demandé une suppression forcée
    if ((isAdmin || isManager) && !forceDelete) {
      this.logger.error(`Tentative de suppression d'un utilisateur privilégié sans forceDelete (ID: ${userId}, Rôles: ${user.roles.map(r => r.name).join(', ')})`);
      throw new ForbiddenException('Les administrateurs et managers ne peuvent pas être supprimés via cet endpoint. Utilisez l\'endpoint /force pour confirmer.');
    }

    // Utiliser une transaction pour garantir l'intégrité des données
    const queryRunner = this.dataSource.createQueryRunner();
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

      // 5. Vérifier les commandes associées
      this.logger.log(`Vérification des commandes associées à l'utilisateur ${userId}`);
      const orders = await queryRunner.manager.query(
        `SELECT id FROM orders WHERE user_id = $1`,
        [userId]
      );
      
      if (orders && orders.length > 0) {
        this.logger.log(`L'utilisateur ${userId} a ${orders.length} commandes associées`);
        // Option : soit supprimer les commandes, soit les anonymiser
        // Pour cet exemple, nous les anonymisons en les associant à un utilisateur "supprimé"
        await queryRunner.manager.query(
          `UPDATE orders SET user_id = NULL WHERE user_id = $1`,
          [userId]
        );
      }

      // 6. Enfin, supprimer l'utilisateur
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

  /**
   * Récupère tous les utilisateurs avec pagination et recherche
   * @param page Numéro de page
   * @param limit Nombre d'utilisateurs par page
   * @param search Terme de recherche (optionnel)
   * @returns Liste paginée des utilisateurs
   */
  async getAllUsers(page: number = 1, limit: number = 10, search?: string): Promise<any> {
    this.logger.log(`Récupération des utilisateurs - Page: ${page}, Limit: ${limit}, Search: ${search || 'none'}`);
    
    // Convertir les paramètres en nombres
    const pageNumber = Number(page) || 1;
    const limitNumber = Number(limit) || 10;
    const skip = (pageNumber - 1) * limitNumber;
    
    try {
      // Construire la requête de base
      const queryBuilder = this.userRepository.createQueryBuilder('user')
        .leftJoinAndSelect('user.roles', 'role')
        .skip(skip)
        .take(limitNumber)
        .orderBy('user.first_name', 'ASC');
      
      // Ajouter la condition de recherche si un terme est fourni
      if (search) {
        queryBuilder.where(
          'LOWER(user.first_name) LIKE LOWER(:search) OR ' +
          'LOWER(user.last_name) LIKE LOWER(:search) OR ' +
          'LOWER(user.email) LIKE LOWER(:search) OR ' +
          'LOWER(user.username) LIKE LOWER(:search)',
          { search: `%${search}%` }
        );
      }
      
      // Exécuter la requête
      const [users, total] = await queryBuilder.getManyAndCount();
      
      // Supprimer les mots de passe des résultats
      const sanitizedUsers = users.map(user => {
        const { password, ...userWithoutPassword } = user;
        return userWithoutPassword;
      });
      
      return {
        data: sanitizedUsers,
        meta: {
          total,
          page: pageNumber,
          limit: limitNumber,
          totalPages: Math.ceil(total / limitNumber),
          hasNextPage: pageNumber < Math.ceil(total / limitNumber),
          hasPreviousPage: pageNumber > 1
        }
      };
    } catch (error) {
      this.logger.error(`Erreur lors de la récupération des utilisateurs: ${error.message}`);
      throw new Error(`Impossible de récupérer les utilisateurs: ${error.message}`);
    }
  }
}
