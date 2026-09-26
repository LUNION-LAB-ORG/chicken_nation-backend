import { NotFoundException } from '@nestjs/common';
import { CrmSegment, Prisma, User } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import * as ExcelJS from 'exceljs';
import { PrismaService } from 'src/database/services/prisma.service';
import { Action } from 'src/modules/auth/enums/action.enum';
import { LigneVenteBrute, MEMBRE_DE_LA_VENTE_SQL, VENTE_DE_CAMPAGNE_SQL, VenteCampagne } from '../crm-campagne.rules';
import { CampaignVentesQueryDto } from '../dto/campaign.dto';
import { CrmAccessService } from './crm-access.service';
import { CrmCampaignStatsService } from './crm-campaign-stats.service';
import { CrmCampaignVentesService } from './crm-campaign-ventes.service';
import { CrmCampaignService } from './crm-campaign.service';
import { CrmEventsService } from './crm-events.service';
import { CrmExportService } from './crm-export.service';
import { CrmReportService } from './crm-report.service';

const CAMPAGNE = '11111111-1111-4111-8111-111111111111';

const LIGNE: LigneVenteBrute = {
  id: 'v1',
  converted_at: new Date('2026-09-20T10:00:00.000Z'),
  montant: 12_050,
  cycle: 1,
  segment: 'GLOVO',
  joined_at: new Date('2026-09-18T10:00:00.000Z'),
  contact_id: 'x1',
  name: 'Awa',
  phone: '2250700000001',
  fiche_supprimee: false,
  compte_id: null,
  first_name: null,
  last_name: null,
  tel_compte: null,
  agent_id: 'ag1',
  agent: 'Agent Un',
  order_id: 'o1',
  reference: 'CMD-1',
  montant_commande: 12_050,
  statut: 'COMPLETED',
  type: 'DELIVERY',
  commande_le: new Date('2026-09-20T09:58:00.000Z'),
  code_promo: 'CN-ABCDEF',
  restaurant: 'Angré',
  coupon_code: 'CN-ABCDEF',
  coupon_offre: '-20 %',
  coupon_envoye_le: new Date('2026-09-19T10:00:00.000Z'),
  coupon_hors_campagne: false,
  delai_campagne_j: 2,
  delai_entree_j: 5,
  autres_nombre: 0,
  autres_valides: 0,
  autres_montant: 0,
  autres: [],
};

/** Résumé renvoyé par la base : une ligne par public, et le total au segment nul. */
const RESUME = [
  { segment: 'YANGO', ventes: 1, ca: 4_000.4 },
  { segment: 'GLOVO', ventes: 2, ca: 20_049.6 },
  { segment: null, ventes: 3, ca: 24_050 },
];

/**
 * Faux Prisma : la campagne (lancée ou non), puis les deux requêtes brutes,
 * reconnues à leur texte. On garde chaque requête pour lire son SQL.
 */
function monter(o: { lancee?: boolean; lignes?: LigneVenteBrute[] } = {}) {
  const requetes: Prisma.Sql[] = [];
  const prisma = {
    crmCampaign: {
      findUnique: jest.fn().mockResolvedValue({
        started_at: o.lancee === false ? null : new Date('2026-09-15T08:00:00.000Z'),
        completed_at: null,
        publics: [{ segment: CrmSegment.YANGO }, { segment: CrmSegment.GLOVO }, { segment: CrmSegment.INACTIF }],
      }),
    },
    $queryRaw: jest.fn((sql: Prisma.Sql) => {
      requetes.push(sql);
      return Promise.resolve(sql.sql.includes('GROUPING SETS') ? RESUME : (o.lignes ?? [LIGNE]));
    }),
  };
  const service = new CrmCampaignVentesService(prisma as unknown as PrismaService);
  const resume = () => requetes.find((r) => r.sql.includes('GROUPING SETS'))!;
  const liste = () => requetes.find((r) => !r.sql.includes('GROUPING SETS'))!;
  return { service, prisma, requetes, resume, liste };
}

/**
 * Les paramètres LIMIT puis OFFSET d'une requête paginée, retrouvés à leur
 * place dans le texte (chaque « ? » est un paramètre, dans l'ordre).
 */
function pagination(sql: Prisma.Sql): unknown[] {
  const position = sql.sql.indexOf('LIMIT ? OFFSET ?');
  if (position < 0) throw new Error('requête sans pagination');
  const rang = (sql.sql.slice(0, position).match(/\?/g) ?? []).length;
  return sql.values.slice(rang, rang + 2);
}
const espaces = (t: string) => t.replace(/\s+/g, ' ');

describe('CrmCampaignVentesService.lister', () => {
  it('20 ventes par page par défaut, à partir de la première', async () => {
    const { service, liste } = monter();
    const r = await service.lister(CAMPAGNE, {});
    expect(pagination(liste())).toEqual([20, 0]);
    expect(r.meta).toEqual({ total: 3, page: 1, limit: 20, totalPages: 1 });
  });

  it("découpe la page avant de chercher le coupon et les autres commandes, puis garde l'ordre", async () => {
    const { service, liste } = monter();
    await service.lister(CAMPAGNE, { segment: CrmSegment.GLOVO });
    const sql = espaces(liste().sql);
    const page = sql.indexOf('LIMIT ? OFFSET ?');
    // Sous-requête « p » : le registre seul, filtré, trié puis découpé.
    expect(sql).toMatch(
      /FROM \( SELECT v\.id FROM "CrmConversion" v JOIN "CrmCampaignMember" m .* WHERE v\.campaign_id = \?::uuid AND .* AND m\.segment = \?::"CrmSegment" ORDER BY v\.converted_at DESC, v\.id DESC LIMIT \? OFFSET \? \) p JOIN "CrmConversion" v ON v\.id = p\.id/,
    );
    expect(page).toBeLessThan(sql.indexOf('LEFT JOIN LATERAL'));
    // Le tri est repris après les jointures : une sous-requête ne garantit pas l'ordre.
    expect(sql.trim().endsWith('ORDER BY v.converted_at DESC, v.id DESC')).toBe(true);
  });

  it('jamais plus de 100 lignes, même si on en demande 500', async () => {
    const { service, liste } = monter();
    await service.lister(CAMPAGNE, { limit: 500 });
    expect(pagination(liste())).toEqual([100, 0]);
  });

  it('décale de (page - 1) × limit', async () => {
    const { service, liste } = monter();
    const r = await service.lister(CAMPAGNE, { page: 3, limit: 10 });
    expect(pagination(liste())).toEqual([10, 20]);
    expect(r.meta).toEqual({ total: 3, page: 3, limit: 10, totalPages: 1 });
  });

  it('le résumé et la liste lisent exactement la vente du compteur', async () => {
    const { service, resume, liste } = monter();
    await service.lister(CAMPAGNE, {});
    for (const sql of [resume(), liste()]) {
      expect(sql.sql).toContain(VENTE_DE_CAMPAGNE_SQL);
      expect(sql.sql).toContain(MEMBRE_DE_LA_VENTE_SQL);
      expect(sql.sql).toContain('FROM "CrmConversion" v');
      expect(sql.values).toContain(CAMPAGNE);
    }
    expect(liste().sql).toContain('JOIN "ConversionCampaign" c ON c.id = v.campaign_id');
  });

  it('le filtre par public ne touche que la liste ; le total est celui du public', async () => {
    const { service, resume, liste } = monter();
    const r = await service.lister(CAMPAGNE, { segment: CrmSegment.GLOVO });
    expect(liste().sql).toContain('AND m.segment = ?::"CrmSegment"');
    expect(liste().values).toContain('GLOVO');
    expect(resume().sql).not.toContain('m.segment = ');
    expect(resume().values).not.toContain('GLOVO');
    expect(r.resume.ventes).toBe(2);
    expect(r.resume.ca).toBe(20_050);
    expect(r.meta.total).toBe(2);
    // Les puces gardent tous les publics, dans l'ordre des tableaux, même sans vente.
    expect(r.resume.par_public).toEqual([
      { segment: 'INACTIF', ventes: 0, ca: 0 },
      { segment: 'GLOVO', ventes: 2, ca: 20_050 },
      { segment: 'YANGO', ventes: 1, ca: 4_000 },
    ]);
  });

  it('sans filtre, le total est la ligne de la campagne entière', async () => {
    const { service } = monter();
    const r = await service.lister(CAMPAGNE, {});
    expect(r.resume).toMatchObject({ ventes: 3, ca: 24_050 });
    expect(r.fenetre).toEqual({ debut: new Date('2026-09-15T08:00:00.000Z'), fin: null });
    expect(r.masque).toBe(false);
  });

  it('trie par date de vente décroissante et date les autres commandes en UTC', async () => {
    const { service, liste } = monter();
    await service.lister(CAMPAGNE, {});
    const sql = espaces(liste().sql);
    expect(sql).toContain('ORDER BY v.converted_at DESC, v.id DESC');
    expect(sql).toMatch(/json_build_object\([^;]*'cree_le', oa\.created_at AT TIME ZONE 'UTC'/);
    // Autres commandes : fenêtre de la campagne, commande comptée exclue, 20 au plus à l'écran.
    expect(sql).toContain('oa.created_at >= c.started_at');
    expect(sql).toContain("oa.created_at < coalesce(c.completed_at, now() AT TIME ZONE 'UTC')");
    expect(sql).toContain('oa.id IS DISTINCT FROM v.order_id');
    expect(sql).toContain('[1:?::int]');
    expect(liste().values).toContain(20);
  });

  it('masque les codes en consultation', async () => {
    const { service } = monter();
    const lecteur = await service.lister(CAMPAGNE, {}, true);
    expect(lecteur.masque).toBe(true);
    expect(lecteur.data[0].coupon?.code).toBe('CN••••');
    const direction = await service.lister(CAMPAGNE, {}, false);
    expect(direction.data[0].coupon?.code).toBe('CN-ABCDEF');
  });

  it("une campagne non lancée n'a aucune vente, sans interroger le registre", async () => {
    const { service, prisma } = monter({ lancee: false });
    const r = await service.lister(CAMPAGNE, {});
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(r.data).toEqual([]);
    expect(r.resume.ventes).toBe(0);
    expect(r.resume.ca).toBe(0);
    expect(r.resume.par_public.every((p) => p.ventes === 0)).toBe(true);
    expect(r.meta.total).toBe(0);
  });

  it('une campagne inconnue répond 404', async () => {
    const { service, prisma } = monter();
    prisma.crmCampaign.findUnique.mockResolvedValueOnce(null);
    await expect(service.lister(CAMPAGNE, {})).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('CampaignVentesQueryDto', () => {
  /** Propriétés refusées pour une requête reçue en texte, comme le fait le ValidationPipe global. */
  const refusees = async (q: Record<string, string>) =>
    (await validate(plainToInstance(CampaignVentesQueryDto, q))).map((e) => e.property);

  it('accepte une page, une taille et un public reçus en texte', async () => {
    expect(await refusees({ page: '2', limit: '100', segment: 'GLOVO' })).toEqual([]);
    expect(plainToInstance(CampaignVentesQueryDto, { page: '2', limit: '100' })).toMatchObject({ page: 2, limit: 100 });
  });

  it('refuse 101 lignes, une page nulle ou démesurée et un public inconnu', async () => {
    expect(await refusees({ limit: '101' })).toEqual(['limit']);
    expect(await refusees({ limit: '0' })).toEqual(['limit']);
    expect(await refusees({ page: '0' })).toEqual(['page']);
    expect(await refusees({ page: '100001' })).toEqual(['page']);
    // 1e300 est un « entier » pour JavaScript : sans borne, il partirait en OFFSET.
    expect(await refusees({ page: '1e300' })).toEqual(['page']);
    expect(await refusees({ page: '1.5' })).toEqual(['page']);
    expect(await refusees({ segment: 'VIP' })).toEqual(['segment']);
  });
});

describe('CrmCampaignVentesService.toutes', () => {
  it('toutes les ventes sans pagination, 100 autres commandes par client, codes en clair', async () => {
    const { service, liste } = monter();
    const ventes = await service.toutes(CAMPAGNE);
    expect(liste().sql).not.toContain('LIMIT ? OFFSET ?');
    expect(liste().sql).not.toContain('m.segment = ');
    expect(liste().values).toContain(100);
    expect(ventes).toHaveLength(1);
    expect(ventes[0].coupon?.code).toBe('CN-ABCDEF');
  });
});

describe('concordance avec le compteur du tableau de bord', () => {
  it('la requête des ventes du compteur emploie les mêmes fragments', async () => {
    const appels: Prisma.Sql[] = [];
    const prisma = {
      $queryRaw: jest.fn((chaines: TemplateStringsArray, ...valeurs: unknown[]) => {
        appels.push(Prisma.sql(chaines, ...(valeurs as Prisma.Sql[])));
        return Promise.resolve([]);
      }),
    };
    await new CrmCampaignStatsService(prisma as unknown as PrismaService).resumes([CAMPAGNE]);
    const compteur = appels.find((a) => a.sql.includes('FROM "CrmConversion" v'));
    expect(compteur).toBeDefined();
    expect(compteur!.sql).toContain(VENTE_DE_CAMPAGNE_SQL);
    expect(compteur!.sql).toContain(MEMBRE_DE_LA_VENTE_SQL);
    expect(compteur!.sql).toContain('count(*)::int AS conversions');
  });
});

describe('CrmCampaignService.ventes', () => {
  function service(o: { visible: boolean; lecteur?: boolean; gestionnaire?: boolean }) {
    const findFirst = jest.fn().mockResolvedValue(o.visible ? { id: CAMPAGNE } : null);
    const prisma = { crmCampaign: { findFirst } } as unknown as PrismaService;
    const access = {
      estGestionnaire: () => !!o.gestionnaire,
      estLecteur: () => !!o.lecteur,
      // Un agent traite, un lecteur ne fait que lire.
      peut: (_u: User, a: Action) => (o.lecteur ? a === Action.READ : true),
    } as unknown as CrmAccessService;
    const lister = jest.fn().mockResolvedValue({ data: [] });
    const ventes = { lister } as unknown as CrmCampaignVentesService;
    const s = new CrmCampaignService(prisma, access, {} as CrmEventsService, {} as CrmCampaignStatsService, ventes);
    return { s, findFirst, lister };
  }
  const agent = { id: 'agent-1' } as User;

  it('un agent hors de la campagne reçoit 404, sans rien lire', async () => {
    const { s, findFirst, lister } = service({ visible: false });
    await expect(s.ventes(agent, CAMPAGNE, {})).rejects.toBeInstanceOf(NotFoundException);
    expect(lister).not.toHaveBeenCalled();
    // La portée d'un agent : les campagnes qu'il pilote ou dont il fait partie.
    const where = findFirst.mock.calls[0][0].where;
    expect(where.OR).toEqual([{ lead_agent_id: 'agent-1' }, { assigned_agents: { some: { agent_id: 'agent-1' } } }]);
  });

  it('un agent de l’équipe voit les codes', async () => {
    const { s, lister } = service({ visible: true });
    await s.ventes(agent, CAMPAGNE, { page: 2 });
    expect(lister).toHaveBeenCalledWith(CAMPAGNE, { page: 2 }, false);
  });

  it('la consultation voit tout, codes masqués', async () => {
    const { s, findFirst, lister } = service({ visible: true, lecteur: true });
    await s.ventes(agent, CAMPAGNE, {});
    expect(findFirst.mock.calls[0][0].where.OR).toBeUndefined();
    expect(lister).toHaveBeenCalledWith(CAMPAGNE, {}, true);
  });
});

describe('Rapport Excel : onglet « Ventes »', () => {
  const vente = (id: string, surcharge: Partial<VenteCampagne> = {}): VenteCampagne => ({
    id,
    vendu_le: new Date('2026-09-20T10:00:00.000Z'),
    montant: 12_050,
    segment: CrmSegment.GLOVO,
    contact: { id: 'x1', nom: 'Awa Koné', telephone: '2250700000001', supprime: false },
    agent: null,
    commande: {
      id: 'o1',
      reference: 'CMD-1',
      montant: 12_050,
      statut: 'COMPLETED',
      type: 'DELIVERY',
      restaurant: 'Angré',
      cree_le: new Date('2026-09-20T09:58:00.000Z'),
    },
    coupon: { code: 'CN-ABCDEF', offre: '-20 %', envoye_le: new Date('2026-09-19T10:00:00.000Z'), hors_campagne: false },
    code_promo: null,
    delai_campagne_jours: 2,
    delai_entree_jours: 5.5,
    autres: {
      nombre: 2,
      valides: 1,
      montant: 3_500,
      tronque: false,
      commandes: [
        { id: 'o3', reference: 'CMD-3', cree_le: new Date('2026-09-22T09:00:00.000Z'), montant: 2_000, statut: 'CANCELLED', type: 'PICKUP', restaurant: 'Angré', etat: 'ANNULEE' },
        { id: 'o2', reference: 'CMD-2', cree_le: new Date('2026-09-21T09:00:00.000Z'), montant: 3_500, statut: 'COMPLETED', type: 'DELIVERY', restaurant: null, etat: 'VALIDE' },
      ],
    },
    ...surcharge,
  });

  /** Statistiques minimales d'une campagne : ce que la synthèse et les onglets lisent. */
  const STATS = {
    campagne: { name: 'Conversion Glovo', lead_agent: { id: 'p', fullname: 'Pilote' }, offer: null, publics: [] },
    duree: { planifiee_jours: 10, reelle_jours: 5, debut_prevu: new Date('2026-09-15'), fin_prevue: new Date('2026-09-25') },
    indicateurs: {
      cibles: 35,
      traites: 10,
      couverture: 28.6,
      joints: 8,
      taux_contact: 80,
      objectif_contacts: null,
      progression_objectif_contacts: null,
      restants: 25,
      coupons_envoyes: 0,
      coupons_utilises: 0,
      taux_utilisation: 0,
      conversions: 2,
      taux_conversion: 5.7,
      objectif_taux_conversion: null,
      ca_conversions: 24_050,
      ca_coupons: 0,
      panier_moyen: 12_025,
    },
    chiffres_figes: false,
    ventes_sans_agent: { conversions: 0, ca: 0 },
    par_public: [],
    statuts: [],
    rythme: { serie: [] },
    agents: [],
    raisons: [],
  };

  it('une ligne par vente, avec les autres commandes en clair', async () => {
    const prisma = {
      crmCampaignMember: { findMany: jest.fn().mockResolvedValue([]) },
      $queryRaw: jest.fn().mockResolvedValue([]),
    } as unknown as PrismaService;
    const stats = { statistiques: jest.fn().mockResolvedValue(STATS) } as unknown as CrmCampaignStatsService;
    const exports = { journaliserExport: jest.fn() } as unknown as CrmExportService;
    const toutes = jest.fn().mockResolvedValue([
      vente('v2'),
      vente('v1', { coupon: null, code_promo: 'NOEL25', agent: { id: 'ag', fullname: 'Agent Un' }, autres: { nombre: 0, valides: 0, montant: 0, tronque: false, commandes: [] } }),
    ]);
    const service = new CrmReportService(prisma, stats, exports, { toutes } as unknown as CrmCampaignVentesService);

    const fichier = await service.generer({ id: 'u' } as User, CAMPAGNE, 'xlsx');
    expect(toutes).toHaveBeenCalledWith(CAMPAGNE);

    const classeur = new ExcelJS.Workbook();
    await classeur.xlsx.load(fichier.contenu as unknown as ArrayBuffer);
    const onglets = classeur.worksheets.map((o) => o.name);
    expect(onglets.indexOf('Ventes')).toBe(onglets.indexOf('Contacts') + 1);
    const o = classeur.getWorksheet('Ventes')!;
    const ligne = (n: number) => (o.getRow(n).values as unknown[]).slice(1);
    expect(ligne(1)[0]).toBe('Vente le');
    expect(ligne(1)).toHaveLength(17);
    expect(o.rowCount).toBe(3);
    const premiere = ligne(2);
    expect(premiere.slice(0, 7)).toEqual(['20/09/2026', 'Awa Koné', '2250700000001', 'Client Glovo', 'Sans agent', 'CMD-1', 12_050]);
    expect(premiere[9]).toBe('CN-ABCDEF');
    expect(premiere[16]).toMatch(/^CMD-3 du 22\/09\/2026, 2.000 F, annulée \(hors total\) ; CMD-2 du 21\/09\/2026, 3.500 F, Terminée$/);
    const seconde = ligne(3);
    expect(seconde[4]).toBe('Agent Un');
    expect(seconde[9]).toBe('code promo NOEL25');
    // Aucun tiret à la place d'une valeur absente.
    for (const cellule of [...premiere, ...seconde]) expect(String(cellule ?? '')).not.toMatch(/[\u2013\u2014]/);
  });
});
