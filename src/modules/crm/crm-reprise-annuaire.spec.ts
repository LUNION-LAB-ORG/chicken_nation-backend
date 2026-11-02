/**
 * Reprise des fausses ventes de l'annuaire (migration du 02/11) et lancement
 * automatique des campagnes : ce que les migrations doivent contenir.
 *
 * Le SQL lui-même a été joué sur une base PostgreSQL en mémoire (PGlite),
 * hors du dépôt, avec des fiches de chaque cas. Ici, on garde les garanties
 * qu'un changement futur pourrait casser sans bruit :
 *  - le script à relancer après un retour à l'ancienne image est le bloc de
 *    la migration, à l'identique ;
 *  - l'ordre des étapes qui en dépend.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const racine = join(__dirname, '../../..');
const lire = (chemin: string) => readFileSync(join(racine, chemin), 'utf8');
const MIGRATION = 'prisma/migrations/20261102100000_crm_annuaire_ventes_annulees/migration.sql';
const SCRIPT = 'scripts/sql/2026-11-02_crm_annuaire_reprise.sql';
const CAMPAGNES = 'prisma/migrations/20261102110000_crm_campagnes_lancement_pause/migration.sql';

/** Le bloc DO, de « DO $$ » à « END $$; ». */
function blocDo(sql: string): string {
  const debut = sql.indexOf('\nDO $$\n');
  const fin = sql.indexOf('\nEND $$;', debut);
  expect(debut).toBeGreaterThan(-1);
  expect(fin).toBeGreaterThan(debut);
  return sql.slice(debut + 1, fin + '\nEND $$;'.length);
}

describe('Reprise de l’annuaire : relançable après un retour à l’ancienne image', () => {
  const migration = lire(MIGRATION);
  const bloc = blocDo(migration);

  it('le script à relancer est le bloc de la migration, à l’identique', () => {
    expect(blocDo(lire(SCRIPT))).toBe(bloc);
  });

  it('la migration dit quoi faire après un retour à l’ancienne image', () => {
    expect(migration).toContain(':prod-rollback');
    expect(migration).toContain(SCRIPT);
  });

  it('les appels et coupons du passage « client actif » supprimé vont à l’historique AVANT la renumérotation', () => {
    const versHistorique = bloc.indexOf('UPDATE "CrmCall" k SET "cycle" = 0');
    const renumerotation = bloc.indexOf('UPDATE "CrmCall" k SET "cycle" = r."cycle"');
    expect(versHistorique).toBeGreaterThan(-1);
    expect(bloc).toContain('UPDATE "CrmCoupon" k SET "cycle" = 0');
    expect(versHistorique).toBeLessThan(renumerotation);
  });

  it('les fiches déjà « rétablies » par l’ancien code, jamais travaillées, redeviennent « non démarchées »', () => {
    const etape = bloc.slice(bloc.indexOf('crm_reprise_annuaire_retablies'));
    for (const garde of [
      `x."segment" = 'CLIENT'`,
      `x."assigned_to_id" IS NULL`,
      `x."campaign_id" IS NULL`,
      `x."call_count" = 0`,
      `NOT EXISTS (SELECT 1 FROM "CrmCoupon" k WHERE k."contact_id" = x."id")`,
      `e."label" <> 'Retiré de son agent'`,
    ]) {
      expect(etape).toContain(garde);
    }
    expect(etape).toContain(`SET "status" = 'NON_DEMARCHE'`);
    expect(etape).toContain(`'cas', 'RETABLIE'`);
  });
});

describe('Lancement automatique : les campagnes planifiées avant lui attendent un clic', () => {
  it('une campagne planifiée dont la date de début est passée au déploiement est mise de côté, avec un mot sur la carte', () => {
    const sql = lire(CAMPAGNES);
    const i = sql.indexOf(`SET "launch_error" = 'Prévue avant le lancement automatique : lancez-la à la main', "launch_failed_at" = now()`);
    expect(i).toBeGreaterThan(-1);
    const garde = sql.slice(i, sql.indexOf(';', i));
    expect(garde).toContain(`"status" = 'PLANIFIED'`);
    expect(garde).toContain(`"start_date" <= now()`);
    expect(garde).toContain(`"launch_failed_at" IS NULL`);
  });
});
