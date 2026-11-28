/**
 * Journal d'audit : ce qui est copié du corps et de la requête.
 *
 * Retours privés « Ton avis compte » : le contenu personnel (commentaire,
 * numéro, prénom, notes des agents, recherche) n'est jamais copié dans
 * audit_logs. Sinon il survivrait à la suppression de l'avis (droit à
 * l'effacement annoncé sur le site : « Pour le faire supprimer : 27 21 71 21 30 »).
 */
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import { AuditInterceptor } from './audit.interceptor';
import { AuditEntry } from './audit.service';
import { IndicesReperes } from './audit-reperes.rules';

const AVIS = '11111111-1111-4111-8111-111111111111';
const AGENT = { id: 'u-cc', fullname: 'Gbonhi Max', role: 'CALL_CENTER', restaurant_id: null };
const COMMANDE = 'a4559e28-1111-4111-8111-111111111111';
const CLIENT = 'c8a3e1f8-2222-4222-8222-222222222222';

/** Indices transmis au service avec chaque ligne, dans l'ordre. */
const indicesRecus: (IndicesReperes | undefined)[] = [];
beforeEach(() => {
  indicesRecus.length = 0;
});

async function journaliser(
  req: Record<string, unknown>,
  statut = 201,
  erreur?: { status: number },
  reponse: unknown = { ok: true },
): Promise<AuditEntry | undefined> {
  const entrees: AuditEntry[] = [];
  const intercepteur = new AuditInterceptor({
    record: (e: AuditEntry, i?: IndicesReperes) => {
      entrees.push(e);
      indicesRecus.push(i);
    },
  } as never);
  const contexte = {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({ headers: {}, ...req }), getResponse: () => ({ statusCode: statut }) }),
  } as unknown as ExecutionContext;
  const suite: CallHandler = { handle: () => (erreur ? throwError(() => erreur) : of(reponse)) };
  await lastValueFrom(intercepteur.intercept(contexte, suite)).catch(() => undefined);
  return entrees[0];
}

describe('AuditInterceptor : contenu personnel des retours privés', () => {
  it('note du journal d’un avis : masquée, l’action et le résultat restent', async () => {
    const entree = await journaliser({
      method: 'POST',
      originalUrl: `/api/v1/avis-prives/${AVIS}/journal`,
      user: AGENT,
      body: { action: 'APPEL', resultat: 'JOINT', note: 'Awa Koné, Riviera 3, rembourser sur Wave au 0707000001' },
    });
    expect(entree?.entity_id).toBe(AVIS);
    expect(entree?.metadata).toEqual({ body: { action: 'APPEL', resultat: 'JOINT', note: '***' } });
    expect(JSON.stringify(entree)).not.toContain('Riviera');
  });

  it('envoi public qui finit en erreur serveur : commentaire, numéro et prénom masqués', async () => {
    const entree = await journaliser(
      {
        method: 'POST',
        originalUrl: '/api/v1/avis-prives',
        body: {
          ressenti: 'PAS_CONTENT',
          canal: 'TELEPHONE',
          commentaire: 'Livreur impoli, je vis à Riviera 3.',
          telephone: '+2250707000001',
          prenom: 'Awa',
        },
      },
      500,
      { status: 500 },
    );
    expect(entree?.metadata).toEqual({
      body: { ressenti: 'PAS_CONTENT', canal: 'TELEPHONE', commentaire: '***', telephone: '***', prenom: '***' },
    });
  });

  it('recherche d’un numéro dans la liste, refusée : masquée dans la requête journalisée', async () => {
    const entree = await journaliser(
      {
        method: 'GET',
        originalUrl: '/api/v1/avis-prives?recherche=0707000001&periode=hier',
        user: AGENT,
        query: { recherche: '0707000001', periode: 'hier' },
      },
      400,
      { status: 400 },
    );
    expect(entree?.metadata).toEqual({ query: { recherche: '***', periode: 'hier' } });
  });

  it('ailleurs, rien ne change : une note d’un autre module reste journalisée', async () => {
    const entree = await journaliser({
      method: 'PATCH',
      originalUrl: '/api/v1/orders/abc/note',
      user: AGENT,
      body: { note: 'Sans piment', password: 'secret' },
    });
    expect(entree?.metadata).toEqual({ body: { note: 'Sans piment', password: '***' } });
  });
});

describe('AuditInterceptor : indices pour les repères de la ligne', () => {
  it('action sur une commande : la commande du chemin, le client du corps', async () => {
    await journaliser({
      method: 'PATCH',
      originalUrl: `/api/v1/orders/${COMMANDE}/client`,
      user: AGENT,
      body: { customer_id: CLIENT, phone: '+2250707070707', fullname: 'Awa Mariam Koné' },
    });
    expect(indicesRecus[0]).toEqual({
      cibles: [
        { type: 'order', id: COMMANDE },
        { type: 'customer', id: CLIENT },
      ],
      fiches: [{ ref: null, nom: 'Awa Mariam Koné', telephone: '+2250707070707', autres: [null] }],
    });
  });

  it('création : la commande renvoyée par le serveur devient la cible', async () => {
    await journaliser({ method: 'POST', originalUrl: '/api/v1/orders', user: AGENT, body: {} }, 201, undefined, {
      id: COMMANDE,
      reference: 'ORD-261128-00042',
    });
    expect(indicesRecus[0]?.cibles).toEqual([{ type: 'order', id: COMMANDE }]);
  });

  it('erreur serveur d’un client : le client qui l’a rencontrée est la personne concernée', async () => {
    await journaliser(
      {
        method: 'POST',
        originalUrl: '/api/v1/orders',
        user: { id: CLIENT, first_name: 'Awa', last_name: 'Koné', phone: '+2250707000001' },
        body: {},
      },
      500,
      { status: 500 },
    );
    expect(indicesRecus[0]?.fiches).toEqual([{ nom: 'Awa Koné', telephone: '+2250707000001', autres: [null] }]);
  });

  it('le personnel est l’auteur, pas la personne concernée', async () => {
    await journaliser({ method: 'PATCH', originalUrl: `/api/v1/orders/${COMMANDE}/status`, user: AGENT, body: {} });
    expect(indicesRecus[0]?.fiches).toEqual([]);
  });

  it('retours privés : aucun indice transmis', async () => {
    await journaliser({
      method: 'POST',
      originalUrl: `/api/v1/avis-prives/${AVIS}/journal`,
      user: AGENT,
      body: { action: 'APPEL', telephone: '+2250707000001', customer_id: CLIENT },
    });
    expect(indicesRecus[0]).toBeUndefined();
  });
});
