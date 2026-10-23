import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

import { CONSERVATION_JOURNAL_DISPATCH_JOURS, joursDeConservation, PurgeJournalDispatchTask } from './purge-journal-dispatch.task';

/**
 * Base du planificateur (seconde relecture du 23/10) : journal de la
 * diffusion conservé 90 jours (conception 3.13), sans purge la table
 * `DispatchEvenement` grossissait sans limite ; index des commandes à livrer,
 * sans lui la tâche de 10 s lisait toute la table des commandes.
 */
describe('purge quotidienne du journal de la diffusion', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  function monter() {
    const prisma = { dispatchEvenement: { deleteMany: jest.fn(async () => ({ count: 3 })) } };
    const tache = new PurgeJournalDispatchTask(prisma as never);
    jest.spyOn((tache as unknown as { logger: { log: () => void } }).logger, 'log').mockImplementation(() => undefined);
    return { prisma, tache };
  }

  it('supprime les lignes de plus de 90 jours', async () => {
    delete process.env.DISPATCH_JOURNAL_RETENTION_DAYS;
    delete process.env.DISABLE_DISPATCH_JOURNAL_PURGE;
    const { prisma, tache } = monter();
    const maintenant = new Date('2026-10-23T04:00:00.000Z');
    expect(await tache.purger(maintenant)).toBe(3);
    expect(prisma.dispatchEvenement.deleteMany).toHaveBeenCalledWith({
      where: { created_at: { lt: new Date('2026-07-25T04:00:00.000Z') } },
    });
  });

  it('0 jour : jamais de purge ; second serveur : coupée', async () => {
    process.env.DISPATCH_JOURNAL_RETENTION_DAYS = '0';
    const a = monter();
    expect(await a.tache.purger()).toBe(0);
    expect(a.prisma.dispatchEvenement.deleteMany).not.toHaveBeenCalled();

    delete process.env.DISPATCH_JOURNAL_RETENTION_DAYS;
    process.env.DISABLE_DISPATCH_JOURNAL_PURGE = 'true';
    const b = monter();
    expect(await b.tache.purger()).toBe(0);
    expect(b.prisma.dispatchEvenement.deleteMany).not.toHaveBeenCalled();
  });

  it('conservation lue : défaut 90, valeur illisible ignorée', () => {
    expect(joursDeConservation(undefined)).toBe(CONSERVATION_JOURNAL_DISPATCH_JOURS);
    expect(joursDeConservation('30')).toBe(30);
    expect(joursDeConservation('abc')).toBe(90);
    expect(joursDeConservation('-4')).toBe(90);
  });
});

describe('index des commandes à livrer (tâche de 10 s, instantané)', () => {
  it('déclaré sur Order (statut, mise à jour) et créé par une migration additive', () => {
    const racine = join(__dirname, '../../../../prisma');
    const schema = readFileSync(join(racine, 'schema.prisma'), 'utf8');
    const modele = schema.slice(schema.indexOf('model Order {'), schema.indexOf('\n}', schema.indexOf('model Order {')));
    expect(modele).toContain('@@index([status, updated_at])');
    const migrations = readdirSync(join(racine, 'migrations'))
      .filter((d) => !d.endsWith('.toml'))
      .map((d) => {
        try {
          return readFileSync(join(racine, 'migrations', d, 'migration.sql'), 'utf8');
        } catch {
          return '';
        }
      });
    expect(migrations.some((sql) => sql.includes('CREATE INDEX IF NOT EXISTS "Order_status_updated_at_idx" ON "Order"("status", "updated_at")'))).toBe(true);
  });
});
