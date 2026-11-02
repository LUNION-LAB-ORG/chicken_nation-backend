/**
 * Envoi PUBLIC d'un avis (contrat 4.1) : vraies barrières Redis (Redis simulé
 * en mémoire, expiration comprise), vrai rapprochement, base simulée.
 */
import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import { AvisCanal, AvisRessenti, AvisStatut, UserRole } from '@prisma/client';
import { creerRedisSimule } from 'src/modules/auth/otp/redis-envois-simule-spec';
import { creerBaseAvis } from './avis-prive-base-simulee-spec';
import { AvisPriveDepotService, champPiegeRempli } from './avis-prive-depot.service';
import { AvisPriveLimitesService, cleDoublon, clePlafondNumero } from './avis-prive-limites.service';
import { AvisPriveNotificationsTemplate } from './avis-prive-notifications.template';
import { CreerAvisPriveDto } from './avis-prive.dto';
import {
  DELAI_ECHEANCE_MS,
  empreinteCommentaire,
  MESSAGE_NUMERO,
  MESSAGE_PLAFOND_GLOBAL,
  MESSAGE_PLAFOND_NUMERO,
  MESSAGE_STORE,
  TEXTE_ALERTE,
} from './avis-prive.rules';
import { AvisPriveService } from './avis-prive.service';

const YOPOUGON = '6b1e0000-0000-4000-8000-000000000001';
const FERME = '6b1e0000-0000-4000-8000-000000000002';
const MAINTENANT = new Date('2026-11-02T08:42:00.000Z');

const ADMIN = { id: 'admin', type: 'backoffice_user' as const, role: UserRole.ADMIN, name: 'Admin', in_app_notifications_enabled: true };
const AGENT = { id: 'cc', type: 'backoffice_user' as const, role: UserRole.CALL_CENTER, name: 'Agent', in_app_notifications_enabled: true };
const MUET = { id: 'cc-muet', type: 'backoffice_user' as const, role: UserRole.CALL_CENTER, name: 'Muet', in_app_notifications_enabled: false };

function monter(depart: Parameters<typeof creerBaseAvis>[0] = {}) {
  const base = creerBaseAvis({
    restaurants: [
      { id: YOPOUGON, name: 'Yopougon', entity_status: 'ACTIVE' },
      { id: FERME, name: 'Ancien store', entity_status: 'INACTIVE' },
    ],
    ...depart,
  });
  const redis = creerRedisSimule();
  const limites = new AvisPriveLimitesService(redis.client);
  const notifications = {
    sendNotificationToMultiple: jest.fn(async (_t: unknown, ctx: { recipients: { id: string }[] }) =>
      ctx.recipients.map((r) => ({ id: `notif-${r.id}` })),
    ),
  };
  const ws = { emitNotification: jest.fn() };
  const destinataires = { getAllUsersByBackofficeAndRole: jest.fn(async () => [ADMIN, AGENT, MUET]) };
  const depot = new AvisPriveDepotService(
    base.prisma as never,
    new AvisPriveService(base.prisma as never),
    limites,
    notifications as never,
    ws as never,
    destinataires as never,
  );
  return { base, redis, depot, notifications, ws, destinataires };
}

const avis = (champs: Partial<CreerAvisPriveDto> = {}): CreerAvisPriveDto => ({
  ressenti: AvisRessenti.PAS_CONTENT,
  canal: AvisCanal.TELEPHONE,
  restaurant_id: YOPOUGON,
  commentaire: 'Commande arrivée avec 1 h de retard et les frites froides.',
  telephone: '07 07 00 00 01',
  prenom: 'Awa',
  accord_rappel: true,
  ...champs,
});

describe('AvisPriveDepotService : champ piège', () => {
  it('rempli : « envoyé », rien d’écrit ni compté, aucune cloche', async () => {
    const { base, redis, depot, notifications } = monter();
    await expect(depot.deposer(avis({ site_web: 'http://spam.example' }), MAINTENANT)).resolves.toEqual({ ok: true });
    expect(base.prisma.avisPrive.create).not.toHaveBeenCalled();
    expect(redis.espions.set).not.toHaveBeenCalled();
    expect(redis.espions.multi).not.toHaveBeenCalled();
    expect(notifications.sendNotificationToMultiple).not.toHaveBeenCalled();
  });

  it('vide ou absent : l’avis passe', () => {
    expect(champPiegeRempli(undefined)).toBe(false);
    expect(champPiegeRempli('')).toBe(false);
    expect(champPiegeRempli('   ')).toBe(false);
    expect(champPiegeRempli('x')).toBe(true);
    expect(champPiegeRempli(1)).toBe(true);
  });
});

describe('AvisPriveDepotService : numéro et store', () => {
  it.each(['27 21 71 21 30', '+33612345678', '07070707', '+225 7 07 00 00 01'])('%s : 400', async (telephone) => {
    const { base, depot } = monter();
    await expect(depot.deposer(avis({ telephone }), MAINTENANT)).rejects.toThrow(MESSAGE_NUMERO);
    expect(base.prisma.avisPrive.create).not.toHaveBeenCalled();
  });

  it('store inactif ou inconnu : 400', async () => {
    const { depot } = monter();
    await expect(depot.deposer(avis({ restaurant_id: FERME }), MAINTENANT)).rejects.toThrow(MESSAGE_STORE);
    await expect(
      depot.deposer(avis({ restaurant_id: '6b1e0000-0000-4000-8000-0000000000ff' }), MAINTENANT),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('« Je ne sais pas » (null) : enregistré sans store', async () => {
    const { base, depot } = monter();
    await depot.deposer(avis({ restaurant_id: null }), MAINTENANT);
    expect(base.prisma.avisPrive.lignes[0].restaurant_id).toBeNull();
  });
});

describe('AvisPriveDepotService : enregistrement', () => {
  it('mobile local normalisé en +225, statut « À rappeler », échéance 24 h, journal de réception', async () => {
    const { base, depot } = monter();
    await expect(depot.deposer(avis(), MAINTENANT)).resolves.toEqual({ ok: true });
    const [a] = base.prisma.avisPrive.lignes;
    expect(a).toMatchObject({
      telephone: '+2250707000001',
      prenom: 'Awa',
      statut: AvisStatut.A_RAPPELER,
      echeance_at: new Date(MAINTENANT.getTime() + DELAI_ECHEANCE_MS),
      accord_rappel: true,
      source: 'site',
      customer_id: null,
    });
    expect(base.suivis(a.id)[0].note).toBe(
      'Avis reçu. Client non rapproché. Statut « À rappeler », échéance 24 h.',
    );
  });

  it('sans accord : « Nouveau », pas d’échéance ; accord absent = non', async () => {
    const { base, depot } = monter();
    await depot.deposer(avis({ accord_rappel: undefined }), MAINTENANT);
    const [a] = base.prisma.avisPrive.lignes;
    expect(a).toMatchObject({ statut: AvisStatut.NOUVEAU, echeance_at: null, accord_rappel: false });
    expect(base.suivis(a.id)[0].note).toBe("Avis reçu. Client non rapproché. Statut « Nouveau ». Pas d'accord de rappel.");
  });

  it('source de la liste blanche gardée, toute autre ramenée à « site »', async () => {
    const { base, depot } = monter();
    await depot.deposer(avis({ source: 'marque-page' }), MAINTENANT);
    await depot.deposer(avis({ source: 'pirate', commentaire: 'Autre chose à dire.' }), MAINTENANT);
    expect(base.prisma.avisPrive.lignes.map((a) => a.source)).toEqual(['marque-page', 'site']);
  });

  it('jamais l’identifiant dans la réponse', async () => {
    const { depot } = monter();
    expect(await depot.deposer(avis(), MAINTENANT)).toStrictEqual({ ok: true });
  });
});

describe('AvisPriveDepotService : rapprochement par téléphone canonique', () => {
  it('compte hérité « 225… » (sans +) : rapproché', async () => {
    const { base, depot } = monter({
      customers: [{ id: 'c-adhesion', phone: '2250707000001', first_name: 'Awa', entity_status: 'ACTIVE', created_at: MAINTENANT }],
    });
    await depot.deposer(avis({ prenom: null }), MAINTENANT);
    const [a] = base.prisma.avisPrive.lignes;
    expect(a).toMatchObject({ customer_id: 'c-adhesion', rapproche_at: MAINTENANT });
    expect(base.suivis(a.id)[0].note).toMatch(/^Avis reçu\. Client rapproché automatiquement\./);
  });

  it('compte « +225… » : rapproché ; l’actif passe devant un plus récent inactif', async () => {
    const { base, depot } = monter({
      customers: [
        { id: 'c-inactif', phone: '+2250707000001', entity_status: 'INACTIVE', created_at: new Date('2026-10-01') },
        { id: 'c-actif', phone: '2250707000001', entity_status: 'ACTIVE', created_at: new Date('2026-01-01') },
      ],
    });
    await depot.deposer(avis(), MAINTENANT);
    expect(base.prisma.avisPrive.lignes[0].customer_id).toBe('c-actif');
  });

  it('compte supprimé : ignoré, « Non rapproché »', async () => {
    const { base, depot } = monter({
      customers: [{ id: 'c-supprime', phone: '+2250707000001', entity_status: 'DELETED', created_at: MAINTENANT }],
    });
    await depot.deposer(avis(), MAINTENANT);
    expect(base.prisma.avisPrive.lignes[0].customer_id).toBeNull();
  });
});

describe('AvisPriveDepotService : doublon et plafonds', () => {
  afterEach(() => {
    delete process.env.AVIS_MAX_PAR_HEURE;
  });

  it('double appui (même numéro, même texte à la casse et aux espaces près) : un seul avis', async () => {
    const { base, depot, notifications } = monter();
    const [r1, r2] = await Promise.all([
      depot.deposer(avis(), MAINTENANT),
      depot.deposer(avis({ commentaire: '  commande arrivée avec 1 h de retard   et les frites froides. ' }), MAINTENANT),
    ]);
    expect(r1).toEqual({ ok: true });
    expect(r2).toEqual({ ok: true });
    expect(base.prisma.avisPrive.create).toHaveBeenCalledTimes(1);
    expect(notifications.sendNotificationToMultiple).toHaveBeenCalledTimes(1);
  });

  it('4e avis du même numéro en 24 h : 429, puis de nouveau possible le lendemain', async () => {
    const { base, redis, depot } = monter();
    for (let i = 1; i <= 3; i++) await depot.deposer(avis({ commentaire: `Retour numéro ${i}.` }), MAINTENANT);
    const refus = depot.deposer(avis({ commentaire: 'Retour numéro 4.' }), MAINTENANT);
    await expect(refus).rejects.toThrow(MESSAGE_PLAFOND_NUMERO);
    await expect(depot.deposer(avis({ commentaire: 'Retour numéro 5.' }), MAINTENANT)).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
    expect(base.prisma.avisPrive.create).toHaveBeenCalledTimes(3);
    // Un refus ne compte rien et ne laisse pas de doublon : le même texte repassera.
    expect(redis.valeur(clePlafondNumero('2250707000001'))).toBe('3');
    expect(redis.valeur(cleDoublon('2250707000001', empreinteCommentaire('Retour numéro 4.')))).toBeNull();

    redis.avancer(24 * 3_600_000 + 1);
    await expect(depot.deposer(avis({ commentaire: 'Retour numéro 4.' }), MAINTENANT)).resolves.toEqual({ ok: true });
  });

  it('plafond global atteint : 429, le compteur du numéro refusé est rendu', async () => {
    process.env.AVIS_MAX_PAR_HEURE = '2';
    const { base, redis, depot } = monter();
    await depot.deposer(avis({ telephone: '0707000001' }), MAINTENANT);
    await depot.deposer(avis({ telephone: '0505000002' }), MAINTENANT);
    await expect(depot.deposer(avis({ telephone: '0101000004' }), MAINTENANT)).rejects.toThrow(MESSAGE_PLAFOND_GLOBAL);
    expect(base.prisma.avisPrive.create).toHaveBeenCalledTimes(2);
    expect(redis.valeur(clePlafondNumero('2250101000004'))).toBe('0');
    expect(redis.valeur('avis:plafond:global')).toBe('2');
  });

  it('Redis en panne : l’avis est enregistré, avec un repli en base pour le plafond par numéro', async () => {
    const { base, redis, depot } = monter();
    redis.panne(true);
    await expect(depot.deposer(avis(), MAINTENANT)).resolves.toEqual({ ok: true });
    expect(base.prisma.avisPrive.create).toHaveBeenCalledTimes(1);

    // Même texte dans les 10 minutes : doublon, lu en base.
    await depot.deposer(avis(), MAINTENANT);
    expect(base.prisma.avisPrive.create).toHaveBeenCalledTimes(1);

    await depot.deposer(avis({ commentaire: 'Deuxième retour.' }), MAINTENANT);
    await depot.deposer(avis({ commentaire: 'Troisième retour.' }), MAINTENANT);
    await expect(depot.deposer(avis({ commentaire: 'Quatrième retour.' }), MAINTENANT)).rejects.toThrow(
      MESSAGE_PLAFOND_NUMERO,
    );
    expect(base.prisma.avisPrive.create).toHaveBeenCalledTimes(3);
  });

  it('écriture en échec : le doublon est levé, le nouvel essai enregistre l’avis', async () => {
    const { base, depot } = monter();
    base.prisma.$transaction.mockRejectedValueOnce(new Error('base injoignable'));
    await expect(depot.deposer(avis(), MAINTENANT)).rejects.toThrow('base injoignable');
    await expect(depot.deposer(avis(), MAINTENANT)).resolves.toEqual({ ok: true });
    expect(base.prisma.avisPrive.lignes).toHaveLength(1);
  });
});

describe('AvisPriveDepotService : cloche', () => {
  it('« Pas content » : ADMIN et CALL_CENTER du siège, une notification chacun, données { kind, avis_id } seulement', async () => {
    const { base, depot, notifications, ws, destinataires } = monter();
    await depot.deposer(avis(), MAINTENANT);
    const [a] = base.prisma.avisPrive.lignes;

    expect(destinataires.getAllUsersByBackofficeAndRole).toHaveBeenCalledWith([UserRole.ADMIN, UserRole.CALL_CENTER]);
    expect(notifications.sendNotificationToMultiple).toHaveBeenCalledTimes(1);
    const [template, contexte] = notifications.sendNotificationToMultiple.mock.calls[0] as unknown as [
      unknown,
      { recipients: { id: string }[]; meta: Record<string, unknown>; data: Record<string, unknown> },
    ];
    expect(template).toBe(AvisPriveNotificationsTemplate.PAS_CONTENT);
    expect(contexte.meta).toEqual({ kind: 'avis', avis_id: a.id });
    for (const interdit of ['reference', 'order_id', 'search', 'ticketId', 'conversationId']) {
      expect(contexte.meta).not.toHaveProperty(interdit);
    }
    // Celui qui a coupé ses notifications n'est pas servi.
    expect(contexte.recipients.map((r) => r.id)).toEqual(['admin', 'cc']);
    expect(contexte.data).toEqual({
      nom: 'Awa',
      store: 'Yopougon',
      extrait: 'Commande arrivée avec 1 h de retard et les frites froides.',
      echeance: '03/11 à 08:42',
    });
    expect(ws.emitNotification).toHaveBeenCalledTimes(2);
    expect(ws.emitNotification.mock.calls.every((appel) => appel.length === 2)).toBe(true);
    expect(base.suivis(a.id).map((s) => s.note)).toContain(TEXTE_ALERTE);
  });

  it('sans prénom ni store : « Sans prénom », « Store inconnu », pas d’échéance sans accord', async () => {
    const { depot, notifications } = monter();
    await depot.deposer(avis({ prenom: '  ', restaurant_id: null, accord_rappel: false }), MAINTENANT);
    const contexte = notifications.sendNotificationToMultiple.mock.calls[0][1] as unknown as { data: Record<string, unknown> };
    expect(contexte.data).toMatchObject({ nom: 'Sans prénom', store: 'Store inconnu', echeance: null });
  });

  it.each([AvisRessenti.PEUT_MIEUX_FAIRE, AvisRessenti.AU_TOP])('%s : aucune cloche', async (ressenti) => {
    const { depot, notifications, destinataires } = monter();
    await depot.deposer(avis({ ressenti }), MAINTENANT);
    expect(destinataires.getAllUsersByBackofficeAndRole).not.toHaveBeenCalled();
    expect(notifications.sendNotificationToMultiple).not.toHaveBeenCalled();
  });

  it('cloche en échec : l’avis est gardé, la réponse reste un succès', async () => {
    const { base, depot, notifications } = monter();
    notifications.sendNotificationToMultiple.mockRejectedValueOnce(new Error('socket coupée'));
    await expect(depot.deposer(avis(), MAINTENANT)).resolves.toEqual({ ok: true });
    const [a] = base.prisma.avisPrive.lignes;
    expect(a.statut).toBe(AvisStatut.A_RAPPELER);
    expect(base.suivis(a.id).map((s) => s.note)).not.toContain(TEXTE_ALERTE);
  });

  it('un refus 429 n’est pas une HttpException « avalée »', async () => {
    const { depot } = monter();
    for (let i = 0; i < 3; i++) await depot.deposer(avis({ commentaire: `Texte ${i}.` }), MAINTENANT);
    await expect(depot.deposer(avis({ commentaire: 'Texte 9.' }), MAINTENANT)).rejects.toBeInstanceOf(HttpException);
  });
});
