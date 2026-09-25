import { Logger } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { UserListenerService } from './user-listener.service';

/**
 * Les écouteurs de suspension, de restauration et de suppression écrivaient la
 * charge entière dans le journal : haché du mot de passe de l'acteur et de la
 * cible compris. Ils ne doivent plus écrire que les identifiants et le rôle.
 */
describe('UserListenerService, journal des comptes', () => {
  const HACHE_ACTEUR = '$2a$10$hacheDeLActeurQuiNeDoitJamaisSortir';
  const HACHE_CIBLE = '$2a$10$hacheDeLaCibleQuiNeDoitJamaisSortir';

  const charge = {
    actor: { id: 'admin-1', role: UserRole.ADMIN, email: 'admin@chicken-nation.test', password: HACHE_ACTEUR },
    data: { id: 'caissier-1', role: UserRole.CAISSIER, email: 'caissier@chicken-nation.test', password: HACHE_CIBLE },
  } as never;

  let journal: jest.SpyInstance;
  let consoleLog: jest.SpyInstance;

  beforeEach(() => {
    journal = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    journal.mockRestore();
    consoleLog.mockRestore();
  });

  const service = new UserListenerService({} as never, {} as never, {} as never, {} as never);

  it.each([
    ['user.deactivated', 'suspendu', (p: never) => service.userDeactivatedEventListener(p)],
    ['user.activated', 'réactivé', (p: never) => service.userActivatedEventListener(p)],
    ['user.deleted', 'supprimé', (p: never) => service.userDeletedEventListener(p)],
  ])('%s : ids et rôle seulement, jamais le haché ni le courriel', async (_evenement, action, ecouter) => {
    await ecouter(charge);

    expect(consoleLog).not.toHaveBeenCalled();
    expect(journal).toHaveBeenCalledTimes(1);
    const ecrit = String(journal.mock.calls[0][0]);
    expect(ecrit).toBe(`Compte caissier-1 (CAISSIER) ${action} par admin-1`);
    expect(ecrit).not.toContain(HACHE_ACTEUR);
    expect(ecrit).not.toContain(HACHE_CIBLE);
    expect(ecrit).not.toContain('@');
  });
});
