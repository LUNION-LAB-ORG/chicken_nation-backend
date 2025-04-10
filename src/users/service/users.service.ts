import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { CreateUserDto } from 'src/users/dto/create-user.dto';
import { EntityStatus, User, UserType } from '@prisma/client';
import { Request } from 'express';
import { PrismaService } from 'src/common/services/prisma.service';
import * as bcrypt from 'bcrypt';
import { UpdateUserDto } from 'src/users/dto/update-user.dto';
import { UpdateUserPasswordDto } from 'src/users/dto/update-user-password.dto';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) { }

  // CREATE
  async create(createUserDto: CreateUserDto) {
    // Vérification de l'existence de l'utilisateur
    const user = await this.prisma.user.findUnique({
      where: {
        email: createUserDto.email,
      },
    });
    if (user) {
      throw new BadRequestException(
        "Utilisateur déjà existant, changer d'email",
      );
    }
    const { password, ...rest } = createUserDto;

    // Générer le salt et le hash
    const salt = await bcrypt.genSalt();
    const hash = await bcrypt.hash(password, salt);

    // Créer l'utilisateur
    return this.prisma.user.create({
      data: {
        ...rest,
        password: hash,
        type: UserType.BACKOFFICE,
      },
      omit: { id: true, password: true },
    });
  }

  // CREATE MEMBER
  async createMember(createUserDto: CreateUserDto) {
    // Vérification de l'existence de l'utilisateur
    const user = await this.prisma.user.findUnique({
      where: {
        email: createUserDto.email,
      },
    });
    if (user) {
      throw new BadRequestException(
        "Utilisateur déjà existant, changer d'email",
      );
    }
    const { password, ...rest } = createUserDto;

    // Générer le salt et le hash
    const salt = await bcrypt.genSalt();
    const hash = await bcrypt.hash(password, salt);

    // Créer l'utilisateur
    return this.prisma.user.create({
      data: {
        ...rest,
        password: hash,
        type: UserType.RESTAURANT,
      },
      omit: { id: true, password: true },
    });
  }

  // FIND_ALL
  async findAll() {
    const users = await this.prisma.user.findMany({
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

    const { password: pass, ...other } = updateUserDto;

    const newUser = await this.prisma.user.update({
      where: {
        id: user.id,
      },
      data: other,
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
