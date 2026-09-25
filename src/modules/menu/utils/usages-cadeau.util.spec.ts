import { User, UserRole, UserType } from '@prisma/client';
import type { Request } from 'express';
import { DishOptionController } from '../controllers/dish-option.controller';
import { DishOptionService } from '../services/dish-option.service';
import { masquerTelephones, peutVoirTelephonesClients } from './usages-cadeau.util';

const siege = (role: UserRole | string) => ({ role, type: UserType.BACKOFFICE });
const restaurant = (role: UserRole | string) => ({ role, type: UserType.RESTAURANT });

describe('peutVoirTelephonesClients', () => {
  it('siège : suit CLIENTS READ de la table des droits', () => {
    expect(peutVoirTelephonesClients(siege(UserRole.ADMIN))).toBe(true);
    expect(peutVoirTelephonesClients(siege(UserRole.MARKETING))).toBe(true);
    expect(peutVoirTelephonesClients(siege(UserRole.CALL_CENTER))).toBe(true);
    // Menus en lecture, mais aucun accès au fichier clients.
    expect(peutVoirTelephonesClients(siege(UserRole.COMPTABLE))).toBe(false);
  });

  it('compte de restaurant : jamais de téléphone, même avec CLIENTS READ', () => {
    // Son fichier clients se limite à son restaurant ; ces cadeaux, non.
    expect(peutVoirTelephonesClients(restaurant(UserRole.MANAGER))).toBe(false);
    expect(peutVoirTelephonesClients(restaurant(UserRole.ASSISTANT_MANAGER))).toBe(false);
    expect(peutVoirTelephonesClients(restaurant(UserRole.CAISSIER))).toBe(false);
    expect(peutVoirTelephonesClients(restaurant(UserRole.CUISINE))).toBe(false);
  });

  it('utilisateur ou rôle absent ou inconnu : jamais de téléphone', () => {
    expect(peutVoirTelephonesClients(undefined)).toBe(false);
    expect(peutVoirTelephonesClients(null)).toBe(false);
    expect(peutVoirTelephonesClients({ role: null, type: UserType.BACKOFFICE })).toBe(false);
    expect(peutVoirTelephonesClients(siege('INCONNU'))).toBe(false);
    expect(peutVoirTelephonesClients(siege('constructor'))).toBe(false);
  });
});

describe('masquerTelephones', () => {
  const cadeaux = [
    { id: 'g1', client: 'Awa Koné', telephone: '+2250700000000', status: 'PENDING' },
    { id: 'g2', client: '', telephone: null, status: 'SCRATCHED' },
  ];

  it('garde le nom et retire le téléphone sans le droit', () => {
    expect(masquerTelephones(cadeaux, false)).toEqual([
      { id: 'g1', client: 'Awa Koné', telephone: null, status: 'PENDING' },
      { id: 'g2', client: '', telephone: null, status: 'SCRATCHED' },
    ]);
  });

  it('laisse tout intact avec le droit', () => {
    expect(masquerTelephones(cadeaux, true)).toBe(cadeaux);
  });
});

describe('DishOptionController.usagesCadeau', () => {
  it("décide des téléphones d'après le compte du jeton", async () => {
    const service = { usagesCadeau: jest.fn().mockResolvedValue({}) };
    const controller = new DishOptionController(service as unknown as DishOptionService);
    const req = (user: Partial<User>) => ({ user }) as unknown as Request;

    await controller.usagesCadeau(req({ role: UserRole.ADMIN, type: UserType.BACKOFFICE }), 'd1');
    expect(service.usagesCadeau).toHaveBeenLastCalledWith('d1', { avecTelephones: true });

    await controller.usagesCadeau(
      req({ role: UserRole.MANAGER, type: UserType.RESTAURANT, restaurant_id: 'r1' }),
      'd1',
    );
    expect(service.usagesCadeau).toHaveBeenLastCalledWith('d1', { avecTelephones: false });
  });
});
