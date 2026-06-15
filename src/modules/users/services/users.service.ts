import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import { CreateUserDto } from '../dto/create-user.dto';
import { EntityStatus, Prisma, User, UserRole, UserType } from '@prisma/client';
import { isStoreRole, resolveStaffType } from '../helpers/staff-type.helper';
import type { Request } from 'express';
import { PrismaService } from 'src/database/services/prisma.service';
import * as bcrypt from 'bcryptjs';
import { UpdateUserDto } from '../dto/update-user.dto';
import { UpdateUserPasswordDto } from '../dto/update-user-password.dto';
import { GenerateDataService } from 'src/common/services/generate-data.service';
import { UserEvent } from '../events/user.event';
import { ResetUserPasswordResponseDto } from '../dto/reset-user-password.dto';
import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService,
    private readonly generateDataService: GenerateDataService,
    private readonly userEvent: UserEvent,
    @Inject(CACHE_MANAGER) private cacheManager: Cache
  ) { }

  // CREATE
  async create(req: Request, createUserDto: CreateUserDto) {
    const user = req.user as User;
    // Vérification de l'existence de l'utilisateur
    const userExist = await this.prisma.user.findUnique({
      where: {
        email: createUserDto.email,
      },
    });
    if (userExist) {
      throw new BadRequestException(
        "Utilisateur déjà existant, changer d'email",
      );
    }

    // Générer le salt et le hash
    const pass = this.generateDataService.generateSecurePassword();
    const salt = await bcrypt.genSalt();
    const hash = await bcrypt.hash(pass, salt);

    // GARDE-FOU : le `type` découle TOUJOURS du rôle (jamais du client ni du
    // créateur). Un rôle de point de vente exige un restaurant de rattachement.
    const { restaurant_id, ...userData } = createUserDto;
    const type = resolveStaffType(createUserDto.role);
    const restaurantId = isStoreRole(createUserDto.role) ? restaurant_id : null;
    if (isStoreRole(createUserDto.role) && !restaurantId) {
      throw new BadRequestException(
        'Un rôle de point de vente (caissier, cuisine, manager, assistant) doit être rattaché à un restaurant.',
      );
    }

    // Créer l'utilisateur
    const newUser = await this.prisma.user.create({
      data: {
        ...userData,
        password: hash,
        type,
        restaurant_id: restaurantId,
      },
      include: {
        restaurant: true,
      },
    });

    // Emettre l'événement de création d'utilisateur
    this.userEvent.userCreatedEvent({ actor: { ...user, restaurant: null }, user: newUser });

    const { password, ...rest } = newUser;

    await this.cacheManager.del("users");
    return { ...rest, password: pass };
  }

  // CREATE MEMBER
  async createMember(req: Request, createUserDto: CreateUserDto) {
    const user = req.user as User;
    // Vérification de l'existence de l'utilisateur
    const userExist = await this.prisma.user.findUnique({
      where: {
        email: createUserDto.email,
      },
    });
    if (userExist) {
      throw new BadRequestException(
        "Utilisateur déjà existant, changer d'email",
      );
    }

    // Générer le salt et le hash
    const pass = this.generateDataService.generateSecurePassword();
    const salt = await bcrypt.genSalt();
    const hash = await bcrypt.hash(pass, salt);

    // GARDE-FOU : type découlé du rôle. Restaurant = celui choisi (admin) sinon
    // celui du créateur (manager qui ajoute un membre de SON restaurant).
    const { restaurant_id, ...memberData } = createUserDto;
    const type = resolveStaffType(createUserDto.role);
    const restaurantId = restaurant_id ?? user.restaurant_id ?? null;
    if (isStoreRole(createUserDto.role) && !restaurantId) {
      throw new BadRequestException(
        'Un rôle de point de vente (caissier, cuisine, manager, assistant) doit être rattaché à un restaurant.',
      );
    }

    // Créer l'utilisateur
    const newUser = await this.prisma.user.create({
      data: {
        ...memberData,
        password: hash,
        restaurant_id: restaurantId,
        type,
      },
      include: {
        restaurant: true,
      },
    });

    // Emettre l'événement de création d'utilisateur
    this.userEvent.memberCreatedEvent({ actor: { ...user, restaurant: null }, user: newUser });

    const { password, ...rest } = newUser;
    return { ...rest, password: pass };
  }

  // FIND_ALL
  async findAll(filters?: { type?: UserType; restaurantId?: string }) {
    // Sans filtre → TOUS les utilisateurs (backoffice + équipes restaurant).
    // Avec `type` ou `restaurantId` → liste ciblée pour les onglets Personnel
    // (Tous = aucun filtre / Back Office = type BACKOFFICE / resto = restaurantId).
    const where: Prisma.UserWhereInput = {};
    if (filters?.type) where.type = filters.type;
    if (filters?.restaurantId) where.restaurant_id = filters.restaurantId;

    const users = await this.prisma.user.findMany({
      where,
      include: {
        restaurant: true,
      },
      orderBy: {
        created_at: 'desc',
      },
      omit: {
        password: true,
      },
    });

    return users;
  }

  /**
   * Définit un manager comme « principal » de son restaurant (Restaurant.manager).
   * Plusieurs managers peuvent être rattachés à un même restaurant ; un seul est
   * principal. Réservé au backoffice (permission PERSONNELS/UPDATE).
   */
  async setPrincipalManager(req: Request, userId: string) {
    void req;
    const target = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!target) {
      throw new NotFoundException('Utilisateur introuvable');
    }
    if (target.role !== UserRole.MANAGER || !target.restaurant_id) {
      throw new BadRequestException(
        'Seul un manager rattaché à un restaurant peut être défini comme principal.',
      );
    }
    await this.prisma.restaurant.update({
      where: { id: target.restaurant_id },
      data: { manager: target.id },
    });
    await this.cacheManager.del('users');
    return {
      success: true,
      restaurant_id: target.restaurant_id,
      manager_id: target.id,
    };
  }

  // DETAIL
  async detail(req: Request) {
    const user = req.user as User;
    const profile = await this.prisma.user.findUnique({
      where: {
        id: user.id,
      },
      include: {
        restaurant: true,
      },
    });

    if (!profile) {
      throw new NotFoundException('Utilisateur non trouvé');
    }
    const { password, ...rest } = profile;

    return rest;
  }

  // UPDATE
  async update(req: Request, updateUserDto: UpdateUserDto) {
    const user = req.user as User;


    const newUser = await this.prisma.user.update({
      where: {
        id: user.id,
      },
      data: updateUserDto,
    });

    const { password, ...rest } = newUser;

    return rest;
  }

  /**
   * Mise à jour d'un membre CIBLÉ par son id (édition par l'admin, ou par
   * l'utilisateur sur son propre profil). Contrairement à `update()` qui ne
   * touchait QUE le compte connecté, celui-ci édite n'importe quel membre et
   * re-dérive type/restaurant depuis le rôle (cohérence garantie).
   */
  async updateById(req: Request, id: string, updateUserDto: UpdateUserDto) {
    const actor = req.user as User;
    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target) {
      throw new NotFoundException('Utilisateur introuvable');
    }
    // Seul un ADMIN peut modifier un AUTRE membre ; chacun peut modifier le sien.
    if (actor.role !== UserRole.ADMIN && actor.id !== id) {
      throw new ForbiddenException(
        "Vous n'avez pas les droits pour modifier ce membre.",
      );
    }

    const { restaurant_id, role, ...rest } = updateUserDto;
    const data: Prisma.UserUpdateInput = { ...rest };

    if (role) {
      data.role = role;
      // Le type découle TOUJOURS du rôle ; un rôle point de vente exige un resto.
      data.type = resolveStaffType(role);
      if (isStoreRole(role)) {
        const rid = restaurant_id ?? target.restaurant_id;
        if (!rid) {
          throw new BadRequestException(
            'Un rôle de point de vente (caissier, cuisine, manager, assistant) doit être rattaché à un restaurant.',
          );
        }
        data.restaurant = { connect: { id: rid } };
      } else {
        data.restaurant = { disconnect: true };
      }
    } else if (restaurant_id !== undefined) {
      data.restaurant = restaurant_id
        ? { connect: { id: restaurant_id } }
        : { disconnect: true };
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data,
      include: { restaurant: true },
    });

    await this.cacheManager.del('users');
    const { password, ...out } = updated;
    return out;
  }

  // UPDATE PASSWORD
  async updatePassword(
    req: Request,
    updateUserPasswordDto: UpdateUserPasswordDto,
  ) {
    const user = req.user as User;

    const { password: pass, confirmPassword } = updateUserPasswordDto;

    if (pass !== confirmPassword) {
      throw new BadRequestException('Les mots de passe ne correspondent pas');
    }

    const salt = await bcrypt.genSalt();
    const hash = await bcrypt.hash(pass, salt);

    const newUser = await this.prisma.user.update({
      where: {
        id: user.id,
      },
      data: {
        password: hash,
        password_is_updated: true
      },
    });

    const { password, ...rest } = newUser;

    return rest;
  }

  async resetPassword(req: Request, user_id: string): Promise<ResetUserPasswordResponseDto> {
    // Générer le salt et le hash
    const pass = this.generateDataService.generateSecurePassword();
    const salt = await bcrypt.genSalt();
    const hash = await bcrypt.hash(pass, salt);

    const user = await this.prisma.user.update({
      where: {
        id: user_id,
      },
      data: {
        password: hash,
        password_is_updated: true
      },
    });

    if (!user) {
      throw new NotFoundException('Utilisateur non trouvé');
    }


    return {
      email: user.email,
      password: pass,
    };

  }

  // PARTIAL DELETE
  async partialRemove(req: Request) {
    const user = req.user as User;

    const newUser = await this.prisma.user.update({
      where: {
        id: user.id,
      },
      data: {
        entity_status: EntityStatus.DELETED,
      },
    });
    // Emettre l'événement de suppression d'utilisateur
    this.userEvent.userDeletedEvent({ actor: user, data: newUser });
    return newUser;
  }

  // INACTIVE
  async inactive(req: Request, id: string) {
    const user = req.user as User;

    const newUser = await this.prisma.user.update({
      where: {
        id: id,
      },
      data: {
        entity_status: EntityStatus.INACTIVE,
      },
    });

    // Emettre l'événement de désactivation d'utilisateur
    this.userEvent.userDeactivatedEvent({ actor: user, data: newUser });
    return newUser;
  }

  // RESTAURATION
  async restore(req: Request, id: string) {
    const user = req.user as User;

    const newUser = await this.prisma.user.update({
      where: {
        id: id,
      },
      data: {
        entity_status: EntityStatus.ACTIVE,
      },
    });

    // Emettre l'événement de restauration d'utilisateur
    this.userEvent.userActivatedEvent({ actor: user, data: newUser });
    return newUser;
  }

  // DELETE
  async remove(req: Request, id: string) {
    const user = req.user as User;

    const deletedUser = await this.prisma.user.delete({
      where: {
        id: id,
      },
    });
    // Emettre l'événement de suppression d'utilisateur
    this.userEvent.userDeletedEvent({ actor: user, data: deletedUser });

    const { password, ...rest } = deletedUser;
    return rest;
  }
}
