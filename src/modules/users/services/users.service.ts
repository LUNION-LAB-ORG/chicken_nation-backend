import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { CreateUserDto } from '../dto/create-user.dto';
import { EntityStatus, User, UserType } from '@prisma/client';
import { Request } from 'express';
import { PrismaService } from 'src/database/services/prisma.service';
import * as bcrypt from 'bcrypt';
import { UpdateUserDto } from '../dto/update-user.dto';
import { UpdateUserPasswordDto } from '../dto/update-user-password.dto';
import { GenerateDataService } from 'src/common/services/generate-data.service';
import { UserEvent } from '../events/user.event';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService,
    private readonly generateDataService: GenerateDataService,
    private readonly userEvent: UserEvent,
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

    // Créer l'utilisateur
    const newUser = await this.prisma.user.create({
      data: {
        ...createUserDto,
        password: hash,
        type: UserType.BACKOFFICE,
      },
      include: {
        restaurant: true,
      },
    });

    // Emettre l'événement de création d'utilisateur
    this.userEvent.userCreatedEvent({ actor: { ...user, restaurant: null }, user: newUser });

    const { password, ...rest } = newUser;
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

    // Créer l'utilisateur
    const newUser = await this.prisma.user.create({
      data: {
        ...createUserDto,
        password: hash,
        restaurant_id: user.restaurant_id,
        type: UserType.RESTAURANT,
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
  async findAll() {
    const users = await this.prisma.user.findMany({
      where: {
        type: UserType.BACKOFFICE,
      },
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
