import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { INTERCEPTORS_METADATA } from '@nestjs/common/constants';
import { EntityStatus, UserRole, UserType } from '@prisma/client';
import type { Request } from 'express';
import { GenerateDataService } from 'src/common/services/generate-data.service';
import { PrismaService } from 'src/database/services/prisma.service';
import { UsersController } from '../controller/users.controller';
import { UserEvent } from '../events/user.event';
import { MESSAGE_HORS_RESTAURANT } from '../helpers/personnel-scope.helper';
import { UsersService } from './users.service';

const R1 = 'resto-1';
const R2 = 'resto-2';
const MOT_DE_PASSE_PROVISOIRE = 'Provisoire#2026';

type Compte = { id: string; role: UserRole; restaurant_id: string | null; type: UserType; email: string };

function compte(id: string, role: UserRole, restaurant_id: string | null): Compte {
  const magasin = [UserRole.MANAGER, UserRole.ASSISTANT_MANAGER, UserRole.CAISSIER, UserRole.CUISINE];
  return {
    id,
    role,
    restaurant_id,
    type: magasin.includes(role as any) ? UserType.RESTAURANT : UserType.BACKOFFICE,
    email: `${id}@chicken-nation.test`,
  };
}

const admin = compte('admin', UserRole.ADMIN, null);
const manager = compte('manager', UserRole.MANAGER, R1);
const autreManager = compte('manager-bis', UserRole.MANAGER, R1);
const assistant = compte('assistant', UserRole.ASSISTANT_MANAGER, R1);
const caissier = compte('caissier', UserRole.CAISSIER, R1);
const caissierAilleurs = compte('caissier-r2', UserRole.CAISSIER, R2);
const marketing = compte('marketing', UserRole.MARKETING, null);

const TOUS = [admin, manager, autreManager, assistant, caissier, caissierAilleurs, marketing];

function req(acteur: Compte): Request {
  return { user: acteur } as unknown as Request;
}

function monter() {
  const prisma = {
    user: {
      // La base connaît les comptes ci-dessus, et un e-mail libre n'appartient à personne.
      findUnique: jest.fn(async ({ where }: { where: { id?: string; email?: string }; select?: unknown }) => {
        if (where.id) return TOUS.find((c) => c.id === where.id) ?? null;
        if (where.email) return TOUS.find((c) => c.email === where.email) ?? null;
        return null;
      }),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(async ({ data }: { data: Record<string, any>; include?: unknown }) => ({
        id: 'nouveau',
        ...data,
        restaurant: null,
      })),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, any>; omit?: unknown; select?: unknown }) => ({
        ...TOUS.find((c) => c.id === where.id),
        ...data,
      })),
      delete: jest.fn(async ({ where }: { where: { id: string }; omit?: unknown }) => TOUS.find((c) => c.id === where.id)),
    },
    restaurant: { update: jest.fn().mockResolvedValue({}) },
  };
  const generateData = { generateSecurePassword: jest.fn(() => MOT_DE_PASSE_PROVISOIRE) };
  const userEvent = {
    userCreatedEvent: jest.fn(),
    memberCreatedEvent: jest.fn(),
    userActivatedEvent: jest.fn(),
    userDeactivatedEvent: jest.fn(),
    userDeletedEvent: jest.fn(),
  };
  const cache = { del: jest.fn() };
  const service = new UsersService(
    prisma as unknown as PrismaService,
    generateData as unknown as GenerateDataService,
    userEvent as unknown as UserEvent,
    cache as never,
  );
  return { prisma, userEvent, service };
}

const nouveauMembre = (role: UserRole, restaurant_id?: string) => ({
  fullname: 'Awa Koné',
  email: 'awa@chicken-nation.test',
  phone: '+2250700000000',
  address: 'Cocody',
  role,
  ...(restaurant_id ? { restaurant_id } : {}),
});

describe('UsersService, création de personnel', () => {
  it("refuse qu'un manager crée un ADMIN ou un autre MANAGER (POST /users et /users/member)", async () => {
    const { prisma, service } = monter();
    await expect(service.create(req(manager), nouveauMembre(UserRole.ADMIN))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.createMember(req(manager), nouveauMembre(UserRole.MANAGER))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.create(req(assistant), nouveauMembre(UserRole.ASSISTANT_MANAGER, R1))).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('un manager crée un caissier dans SON restaurant, jamais dans un autre', async () => {
    const { prisma, service } = monter();
    await expect(service.createMember(req(manager), nouveauMembre(UserRole.CAISSIER, R2))).rejects.toThrow(MESSAGE_HORS_RESTAURANT);
    expect(prisma.user.create).not.toHaveBeenCalled();

    await service.create(req(manager), nouveauMembre(UserRole.CAISSIER));
    expect(prisma.user.create.mock.calls[0][0].data).toMatchObject({
      role: UserRole.CAISSIER,
      type: UserType.RESTAURANT,
      restaurant_id: R1,
    });
  });

  it("l'ADMIN crée un manager dans le restaurant choisi ; la réponse porte le mot de passe provisoire, jamais le haché", async () => {
    const { prisma, service } = monter();
    const cree = await service.create(req(admin), nouveauMembre(UserRole.MANAGER, R2));
    const data = prisma.user.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ role: UserRole.MANAGER, type: UserType.RESTAURANT, restaurant_id: R2 });
    expect(data.password).not.toBe(MOT_DE_PASSE_PROVISOIRE);
    expect(cree.password).toBe(MOT_DE_PASSE_PROVISOIRE);
  });
});

describe('UsersService, liste du personnel (GET /users)', () => {
  it('un compte de restaurant ne voit que son restaurant, même en demandant un autre', async () => {
    const { prisma, service } = monter();
    await service.findAll(req(manager), { restaurantId: R2 });
    const args = prisma.user.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ restaurant_id: R1 });
    expect(args.omit).toEqual({ password: true });
  });

  it("l'ADMIN garde les onglets : un restaurant, le siège ou tout le réseau", async () => {
    const { prisma, service } = monter();
    await service.findAll(req(admin), { restaurantId: R2 });
    await service.findAll(req(admin), { type: UserType.BACKOFFICE });
    await service.findAll(req(admin), {});
    expect(prisma.user.findMany.mock.calls.map((c) => c[0].where)).toEqual([
      { restaurant_id: R2 },
      { type: UserType.BACKOFFICE },
      {},
    ]);
  });
});

describe('UsersService.updateById', () => {
  it("refuse qu'un manager se promeuve ADMIN sur son propre profil", async () => {
    const { prisma, service } = monter();
    await expect(service.updateById(req(manager), manager.id, { role: UserRole.ADMIN })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.updateById(req(manager), manager.id, { restaurant_id: R2 })).rejects.toThrow(MESSAGE_HORS_RESTAURANT);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('son propre profil, formulaire complet renvoyé tel quel : seul le profil change', async () => {
    const { prisma, service } = monter();
    await service.updateById(req(manager), manager.id, {
      fullname: 'Nouveau nom',
      role: UserRole.MANAGER,
      restaurant_id: R1,
    });
    const args = prisma.user.update.mock.calls[0][0];
    expect(args.data).toEqual({ fullname: 'Nouveau nom' });
    expect(args.omit).toEqual({ password: true });
  });

  it('un manager change le rôle de son caissier vers un rôle inférieur au sien seulement', async () => {
    const { prisma, service } = monter();
    await service.updateById(req(manager), caissier.id, { role: UserRole.CUISINE, restaurant_id: R1 });
    expect(prisma.user.update.mock.calls[0][0].data).toEqual({ role: UserRole.CUISINE, type: UserType.RESTAURANT });

    await expect(service.updateById(req(manager), caissier.id, { role: UserRole.MANAGER })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.updateById(req(manager), caissier.id, { restaurant_id: R2 })).rejects.toThrow(MESSAGE_HORS_RESTAURANT);
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
  });

  it("un assistant ne modifie ni un manager ni le personnel d'un autre restaurant ; un manager ne modifie pas le siège", async () => {
    const { prisma, service } = monter();
    await expect(service.updateById(req(assistant), manager.id, { fullname: 'x' })).rejects.toThrow(MESSAGE_HORS_RESTAURANT);
    await expect(service.updateById(req(manager), caissierAilleurs.id, { fullname: 'x' })).rejects.toThrow(MESSAGE_HORS_RESTAURANT);
    await expect(service.updateById(req(manager), marketing.id, { fullname: 'x' })).rejects.toThrow(MESSAGE_HORS_RESTAURANT);
    await expect(service.updateById(req(manager), autreManager.id, { fullname: 'x' })).rejects.toThrow(MESSAGE_HORS_RESTAURANT);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("refuse une adresse email déjà prise par un autre compte", async () => {
    const { prisma, service } = monter();
    await expect(service.updateById(req(admin), caissier.id, { email: marketing.email })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("l'ADMIN déplace un membre et change son rôle ; le type suit le rôle", async () => {
    const { prisma, service } = monter();
    await service.updateById(req(admin), caissier.id, { role: UserRole.MARKETING });
    expect(prisma.user.update.mock.calls[0][0].data).toMatchObject({
      role: UserRole.MARKETING,
      type: UserType.BACKOFFICE,
      restaurant: { disconnect: true },
    });
  });
});

describe('UsersService, réinitialisation du mot de passe', () => {
  it("refuse hors de son restaurant ou au-dessus de son rang, sans toucher au mot de passe", async () => {
    const { prisma, service } = monter();
    await expect(service.resetPassword(req(manager), caissierAilleurs.id)).rejects.toThrow(MESSAGE_HORS_RESTAURANT);
    await expect(service.resetPassword(req(assistant), manager.id)).rejects.toThrow(MESSAGE_HORS_RESTAURANT);
    await expect(service.resetPassword(req(manager), admin.id)).rejects.toThrow(MESSAGE_HORS_RESTAURANT);
    await expect(service.resetPassword(req(admin), 'inconnu')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('un manager réinitialise son caissier et ne reçoit que le courriel et le mot de passe provisoire', async () => {
    const { prisma, service } = monter();
    const res = await service.resetPassword(req(manager), caissier.id);
    expect(res).toEqual({ email: caissier.email, password: MOT_DE_PASSE_PROVISOIRE });
    const args = prisma.user.update.mock.calls[0][0];
    expect(args.select).toEqual({ id: true });
    expect(args.data.password).not.toBe(MOT_DE_PASSE_PROVISOIRE);
  });
});

describe('UsersService, suspension, restauration, suppression', () => {
  it('le manager suspend son caissier : statut INACTIVE, réponse sans haché, événement émis', async () => {
    const { prisma, userEvent, service } = monter();
    await service.inactive(req(manager), caissier.id);
    const args = prisma.user.update.mock.calls[0][0];
    expect(args).toMatchObject({
      where: { id: caissier.id },
      data: { entity_status: EntityStatus.INACTIVE },
      omit: { password: true },
    });
    expect(userEvent.userDeactivatedEvent).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ id: caissier.id }) }),
    );
  });

  it("refuse de suspendre ou de restaurer un compte qu'on ne gère pas, et sa propre suspension", async () => {
    const { prisma, service } = monter();
    await expect(service.inactive(req(assistant), manager.id)).rejects.toThrow(MESSAGE_HORS_RESTAURANT);
    await expect(service.inactive(req(manager), admin.id)).rejects.toThrow(MESSAGE_HORS_RESTAURANT);
    await expect(service.restore(req(manager), marketing.id)).rejects.toThrow(MESSAGE_HORS_RESTAURANT);
    await expect(service.restore(req(manager), caissierAilleurs.id)).rejects.toThrow(MESSAGE_HORS_RESTAURANT);
    await expect(service.inactive(req(admin), admin.id)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('refuse de restaurer son propre compte, ADMIN compris', async () => {
    const { prisma, userEvent, service } = monter();
    await expect(service.restore(req(manager), manager.id)).rejects.toThrow(
      'Vous ne pouvez pas restaurer votre propre compte.',
    );
    await expect(service.restore(req(admin), admin.id)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(userEvent.userActivatedEvent).not.toHaveBeenCalled();
  });

  it('la restauration et la suppression ne renvoient pas le haché', async () => {
    const { prisma, service } = monter();
    await service.restore(req(manager), caissier.id);
    expect(prisma.user.update.mock.calls[0][0].omit).toEqual({ password: true });
    await service.remove(req(admin), caissier.id);
    expect(prisma.user.delete.mock.calls[0][0]).toEqual({ where: { id: caissier.id }, omit: { password: true } });
    await expect(service.remove(req(admin), admin.id)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("seul l'ADMIN désigne le manager principal", async () => {
    const { prisma, service } = monter();
    await expect(service.setPrincipalManager(req(manager), autreManager.id)).rejects.toThrow(MESSAGE_HORS_RESTAURANT);
    await expect(service.setPrincipalManager(req(manager), manager.id)).rejects.toThrow(MESSAGE_HORS_RESTAURANT);
    expect(prisma.restaurant.update).not.toHaveBeenCalled();
    await service.setPrincipalManager(req(admin), autreManager.id);
    expect(prisma.restaurant.update).toHaveBeenCalledWith({ where: { id: R1 }, data: { manager: autreManager.id } });
  });

  it('la suppression sans cible (DELETE /users) a disparu', () => {
    const { service } = monter();
    expect((service as unknown as Record<string, unknown>).partialRemove).toBeUndefined();
    expect((UsersController.prototype as unknown as Record<string, unknown>).partialDelete).toBeUndefined();
  });
});

describe('UsersController, cache', () => {
  it('ne met en cache ni le profil (GET /users/detail) ni la liste (GET /users)', () => {
    expect(Reflect.getMetadata(INTERCEPTORS_METADATA, UsersController)).toBeUndefined();
    expect(Reflect.getMetadata(INTERCEPTORS_METADATA, UsersController.prototype.detail)).toBeUndefined();
    expect(Reflect.getMetadata(INTERCEPTORS_METADATA, UsersController.prototype.findAll)).toBeUndefined();
  });
});
