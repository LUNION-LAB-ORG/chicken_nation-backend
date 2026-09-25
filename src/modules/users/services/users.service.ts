import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import { CreateUserDto } from '../dto/create-user.dto';
import { EntityStatus, Prisma, User, UserRole, UserType } from '@prisma/client';
import { isStoreRole, resolveStaffType } from '../helpers/staff-type.helper';
import {
  assertPeutAttribuerRole,
  assertPeutGererMembre,
  estAdministrateur,
  MESSAGE_HORS_RESTAURANT,
  restaurantDuNouveauMembre,
  restaurantDuPersonnelVisible,
} from '../helpers/personnel-scope.helper';
import type { Request } from 'express';
import { PrismaService } from 'src/database/services/prisma.service';
import * as bcrypt from 'bcryptjs';
import { UpdateUserDto } from '../dto/update-user.dto';
import { UpdateUserPasswordDto } from '../dto/update-user-password.dto';
import { GenerateDataService } from 'src/common/services/generate-data.service';
import { UserEvent } from '../events/user.event';
import { ResetUserPasswordResponseDto } from '../dto/reset-user-password.dto';
import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager';
import { RESTAURANT_PERSONNEL_SELECT } from 'src/modules/restaurant/constantes/restaurant-public.select';

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

    // GARDE-FOU : le `type` découle TOUJOURS du rôle (jamais du client ni du
    // créateur). Un rôle de point de vente exige un restaurant de rattachement.
    // Un non-ADMIN ne crée qu'un rôle inférieur au sien, dans SON restaurant
    // (voir personnel-scope.helper.ts).
    const { restaurant_id, ...userData } = createUserDto;
    assertPeutAttribuerRole(user, createUserDto.role);
    const type = resolveStaffType(createUserDto.role);
    const restaurantId = restaurantDuNouveauMembre(user, createUserDto.role, restaurant_id);
    if (isStoreRole(createUserDto.role) && !restaurantId) {
      throw new BadRequestException(
        'Un rôle de point de vente (caissier, cuisine, manager, assistant) doit être rattaché à un restaurant.',
      );
    }

    // Vérification de l'existence de l'utilisateur
    const userExist = await this.prisma.user.findUnique({
      where: {
        email: createUserDto.email,
      },
      select: { id: true },
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

    // Créer l'utilisateur
    const newUser = await this.prisma.user.create({
      data: {
        ...userData,
        password: hash,
        type,
        restaurant_id: restaurantId,
      },
      include: {
        restaurant: { select: RESTAURANT_PERSONNEL_SELECT },
      },
    });

    // Emettre l'événement de création d'utilisateur
    this.userEvent.userCreatedEvent({ actor: { ...user, restaurant: null }, user: newUser });

    // Le haché ne sort jamais ; le mot de passe provisoire, en clair, est
    // montré UNE fois à celui qui crée le compte.
    const { password, ...rest } = newUser;

    await this.cacheManager.del("users");
    return { ...rest, password: pass };
  }

  // CREATE MEMBER
  async createMember(req: Request, createUserDto: CreateUserDto) {
    const user = req.user as User;

    // GARDE-FOU : type découlé du rôle. Restaurant = celui choisi (admin) sinon
    // celui du créateur ; un manager ou un assistant crée TOUJOURS dans SON
    // restaurant, et seulement un rôle inférieur au sien.
    const { restaurant_id, ...memberData } = createUserDto;
    assertPeutAttribuerRole(user, createUserDto.role);
    const type = resolveStaffType(createUserDto.role);
    const restaurantId = restaurantDuNouveauMembre(user, createUserDto.role, restaurant_id, {
      restaurantParDefaut: true,
    });
    if (isStoreRole(createUserDto.role) && !restaurantId) {
      throw new BadRequestException(
        'Un rôle de point de vente (caissier, cuisine, manager, assistant) doit être rattaché à un restaurant.',
      );
    }

    // Vérification de l'existence de l'utilisateur
    const userExist = await this.prisma.user.findUnique({
      where: {
        email: createUserDto.email,
      },
      select: { id: true },
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

    // Créer l'utilisateur
    const newUser = await this.prisma.user.create({
      data: {
        ...memberData,
        password: hash,
        restaurant_id: restaurantId,
        type,
      },
      include: {
        restaurant: { select: RESTAURANT_PERSONNEL_SELECT },
      },
    });

    // Emettre l'événement de création d'utilisateur
    this.userEvent.memberCreatedEvent({ actor: { ...user, restaurant: null }, user: newUser });

    const { password, ...rest } = newUser;
    return { ...rest, password: pass };
  }

  // FIND_ALL
  async findAll(req: Request, filters?: { type?: UserType; restaurantId?: string }) {
    // Compte du siège : sans filtre → TOUS les utilisateurs (backoffice +
    // équipes restaurant) ; avec `type` ou `restaurantId` → liste ciblée pour
    // les onglets Personnel (Tous / Back Office / resto).
    // Compte de restaurant (manager, assistant, la caisse) : TOUJOURS son
    // restaurant, quel que soit le paramètre reçu. Il lisait tout le réseau.
    const acteur = req.user as User;
    const where: Prisma.UserWhereInput = {};
    if (filters?.type) where.type = filters.type;
    const restaurantId = restaurantDuPersonnelVisible(acteur, filters?.restaurantId);
    if (restaurantId) where.restaurant_id = restaurantId;

    const users = await this.prisma.user.findMany({
      where,
      include: {
        // Liste blanche : la ligne complète portait la clé Turbo et le jeton
        // HubRise de chaque restaurant, à tout lecteur du personnel.
        restaurant: { select: RESTAURANT_PERSONNEL_SELECT },
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
   * principal. Permission PERSONNELS/UPDATE, et la cible doit être gérée par le
   * compte connecté : en pratique l'ADMIN, un manager ne gérant pas un autre
   * manager (ni lui-même).
   */
  async setPrincipalManager(req: Request, userId: string) {
    const acteur = req.user as User;
    const target = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, restaurant_id: true },
    });
    if (!target) {
      throw new NotFoundException('Utilisateur introuvable');
    }
    assertPeutGererMembre(acteur, target);
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
        restaurant: { select: RESTAURANT_PERSONNEL_SELECT },
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

    /**
     * ⚠️ FAILLE CRITIQUE CORRIGEE : le DTO ENTIER partait dans `data`.
     *
     * `UpdateUserDto` dérive de `CreateUserDto`, qui déclare `role`, `type` et
     * `restaurant_id`. La route ne portant aucune permission, tout membre du
     * personnel connecté, caissier compris, se promouvait ADMIN avec un simple
     * `{"role":"ADMIN"}`, ou se rattachait au restaurant de son choix. C'est
     * une élévation de privilèges en une requête.
     *
     * On ne modifie plus que le PROFIL, par liste blanche explicite. Le rôle,
     * le type et le rattachement restent la prérogative des routes
     * d'administration, qui portent leurs permissions. `undefined` laisse la
     * colonne inchangée côté Prisma, donc une absence de champ ne l'efface pas.
     */
    const profil = {
      fullname: updateUserDto.fullname,
      phone: updateUserDto.phone,
      address: updateUserDto.address,
      image: updateUserDto.image,
    };

    const newUser = await this.prisma.user.update({
      where: {
        id: user.id,
      },
      data: profil,
    });

    const { password, ...rest } = newUser;

    return rest;
  }

  /**
   * Mise à jour d'un membre CIBLÉ par son id (édition par l'admin ou par un
   * responsable de restaurant, ou par l'utilisateur sur son propre profil).
   * Contrairement à `update()` qui ne touche QUE le compte connecté, celui-ci
   * édite un autre membre et re-dérive type/restaurant depuis le rôle.
   *
   *  - ADMIN : n'importe quel membre, rôle et rattachement compris ;
   *  - manager, assistant : le personnel de SON restaurant, de rang inférieur ;
   *    le rôle ne peut devenir qu'un rôle inférieur au sien et le restaurant ne
   *    change pas ;
   *  - sur son propre profil, un non-ADMIN ne change ni son rôle ni son
   *    restaurant (c'était une promotion ADMIN en une requête).
   */
  async updateById(req: Request, id: string, updateUserDto: UpdateUserDto) {
    const actor = req.user as User;
    const target = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, role: true, restaurant_id: true, email: true },
    });
    if (!target) {
      throw new NotFoundException('Utilisateur introuvable');
    }
    const admin = estAdministrateur(actor);
    const soiMeme = actor.id === target.id;
    if (!soiMeme) {
      assertPeutGererMembre(actor, target);
    }

    const { restaurant_id, role, email, ...profil } = updateUserDto;
    const data: Prisma.UserUpdateInput = { ...profil };

    if (email !== undefined && email !== target.email) {
      const dejaPris = await this.prisma.user.findUnique({
        where: { email },
        select: { id: true },
      });
      if (dejaPris && dejaPris.id !== target.id) {
        throw new BadRequestException(
          'Cette adresse email est déjà utilisée par un autre compte.',
        );
      }
      data.email = email;
    }

    if (admin) {
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
    } else {
      // Le rattachement reste celui du membre : un autre restaurant est refusé.
      if (restaurant_id !== undefined && (restaurant_id || null) !== target.restaurant_id) {
        throw new ForbiddenException(MESSAGE_HORS_RESTAURANT);
      }
      // Le rôle renvoyé tel quel par le formulaire ne change rien.
      if (role !== undefined && role !== target.role) {
        if (soiMeme) {
          throw new ForbiddenException('Vous ne pouvez pas modifier votre propre rôle.');
        }
        assertPeutAttribuerRole(actor, role);
        data.role = role;
        data.type = resolveStaffType(role);
      }
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data,
      include: { restaurant: { select: RESTAURANT_PERSONNEL_SELECT } },
      omit: { password: true },
    });

    await this.cacheManager.del('users');
    return updated;
  }

  /**
   * Charge un membre visé par une action d'administration (réinitialisation,
   * suspension, restauration, suppression) et vérifie que le compte connecté
   * le gère. Son propre compte est laissé à la décision de l'appelant.
   */
  private async chargerMembreGere(acteur: User, id: string) {
    const cible = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, role: true, restaurant_id: true, email: true },
    });
    if (!cible) {
      throw new NotFoundException('Utilisateur non trouvé');
    }
    if (cible.id !== acteur.id) {
      assertPeutGererMembre(acteur, cible);
    }
    return cible;
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
    const acteur = req.user as User;
    const cible = await this.chargerMembreGere(acteur, user_id);

    // Générer le salt et le hash
    const pass = this.generateDataService.generateSecurePassword();
    const salt = await bcrypt.genSalt();
    const hash = await bcrypt.hash(pass, salt);

    await this.prisma.user.update({
      where: {
        id: cible.id,
      },
      data: {
        password: hash,
        password_is_updated: true
      },
      select: { id: true },
    });

    return {
      email: cible.email,
      password: pass,
    };
  }

  // INACTIVE (bouton « Suspendre » du backoffice)
  async inactive(req: Request, id: string) {
    const user = req.user as User;
    const cible = await this.chargerMembreGere(user, id);
    if (cible.id === user.id) {
      throw new BadRequestException('Vous ne pouvez pas suspendre votre propre compte.');
    }

    const newUser = await this.prisma.user.update({
      where: {
        id: cible.id,
      },
      data: {
        entity_status: EntityStatus.INACTIVE,
      },
      omit: { password: true },
    });

    // Emettre l'événement de désactivation d'utilisateur
    this.userEvent.userDeactivatedEvent({ actor: user, data: newUser });
    return newUser;
  }

  // RESTAURATION
  async restore(req: Request, id: string) {
    const user = req.user as User;
    const cible = await this.chargerMembreGere(user, id);
    // Un compte suspendu dont le jeton vivrait encore ne se rétablit pas lui-même.
    if (cible.id === user.id) {
      throw new BadRequestException('Vous ne pouvez pas restaurer votre propre compte.');
    }

    const newUser = await this.prisma.user.update({
      where: {
        id: cible.id,
      },
      data: {
        entity_status: EntityStatus.ACTIVE,
      },
      omit: { password: true },
    });

    // Emettre l'événement de restauration d'utilisateur
    this.userEvent.userActivatedEvent({ actor: user, data: newUser });
    return newUser;
  }

  // DELETE
  async remove(req: Request, id: string) {
    const user = req.user as User;
    const cible = await this.chargerMembreGere(user, id);
    if (cible.id === user.id) {
      throw new BadRequestException('Vous ne pouvez pas supprimer votre propre compte.');
    }

    const deletedUser = await this.prisma.user.delete({
      where: {
        id: cible.id,
      },
      omit: { password: true },
    });
    // Emettre l'événement de suppression d'utilisateur
    this.userEvent.userDeletedEvent({ actor: user, data: deletedUser });

    return deletedUser;
  }
}
