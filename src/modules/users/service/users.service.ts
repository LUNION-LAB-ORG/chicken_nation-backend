import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { CreateUserDto } from 'src/modules/users/dto/create-user.dto';
import { EntityStatus, User, UserType } from '@prisma/client';
import { Request } from 'express';
import { PrismaService } from 'src/database/services/prisma.service';
import * as bcrypt from 'bcrypt';
import { UpdateUserDto } from 'src/modules/users/dto/update-user.dto';
import { UpdateUserPasswordDto } from 'src/modules/users/dto/update-user-password.dto';
import { GenerateDataService } from 'src/common/services/generate-data.service';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService, private readonly generateDataService: GenerateDataService) { }

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
      omit: { id: true, password: true },
    });

    return { ...newUser, password: pass };
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
      omit: { id: true, password: true },
    });

    return { ...newUser, password: pass };
  }

  // FIND_ALL
  async findAll() {
    const users = await this.prisma.user.findMany({
      where: {
        entity_status: EntityStatus.ACTIVE,
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

    return this.prisma.user.update({
      where: {
        id: user.id,
      },
      data: {
        entity_status: EntityStatus.DELETED,
      },
    });
  }
  // INACTIVE
  async inactive(req: Request) {
    const user = req.user as User;

    return this.prisma.user.update({
      where: {
        id: user.id,
      },
      data: {
        entity_status: EntityStatus.INACTIVE,
      },
    });
  }
  // RESTAURATION
  async restore(req: Request) {
    const user = req.user as User;

    return this.prisma.user.update({
      where: {
        id: user.id,
      },
      data: {
        entity_status: EntityStatus.ACTIVE,
      },
    });
  }

  // DELETE
  async remove(req: Request, id: string) {
    const user = req.user as User;

    return this.prisma.user.delete({
      where: {
        id: id,
      },
    });
  }
}
