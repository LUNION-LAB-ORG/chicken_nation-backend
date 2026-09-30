import { CHAMPS_CENTRE_APPELS, pourAnnuaire } from './crm-contact.query';

/**
 * Le mode « annuaire » sépare le fichier client du centre d'appels.
 *
 * Ces tests existent parce qu'un masquage d'onglet ne protège rien : la
 * réponse du serveur partait entière, et seul l'écran décidait d'en cacher
 * une partie. La séparation se joue dans la projection, et c'est elle qu'on
 * vérifie ici.
 */
describe('pourAnnuaire', () => {
  /** Une fiche complète, telle que le service la construit. */
  const ficheComplete = () => ({
    id: 'c1',
    nom: 'Awa Koné',
    telephone: '+2250700000001',
    segment: 'GLOVO',
    customer: { id: 'u1', first_name: 'Awa', last_name: 'Koné' },
    achats: { commandes: 7, montant: 83770 },
    captures: [{ id: 'k1', plateforme: 'YANGO' }],
    // Tout ce qui suit relève du centre d'appels.
    appels: [{ id: 'a1', reached: true }],
    coupons: [{ id: 'co1', code: 'SECRET42' }],
    campagnes: [{ campaign: { id: 'ca1', name: 'Conversion Glovo' } }],
    journal: [{ id: 'j1', label: 'Pris dans la file commune' }],
    coupon: { code: 'SECRET42', etat: 'ACTIF' },
    assigned_to: { id: 'ag1', fullname: 'Lana KOUAKOU' },
    assigned_to_id: 'ag1',
    last_call_status: { id: 's1', label: 'Intéressé' },
    loss_reason: { id: 'r1', name: 'Trop cher' },
    last_comment: 'Rappeler après 18h',
    callback_at: '2026-10-01T18:00:00.000Z',
    last_call_at: '2026-09-30T10:00:00.000Z',
    last_call_outcome: 'JOINT',
    call_count: 3,
    mode: 'annuaire',
  });

  it('vide tout ce qui relève du centre d’appels', () => {
    const vue = pourAnnuaire(ficheComplete()) as Record<string, unknown>;
    for (const champ of CHAMPS_CENTRE_APPELS) {
      const valeur = vue[champ];
      const videe = Array.isArray(valeur) ? valeur.length === 0 : valeur === null;
      expect({ champ, valeur }).toEqual({ champ, valeur: videe ? valeur : 'NON VIDÉ' });
    }
  });

  it('ne laisse fuiter aucun code de coupon, où qu’il soit', () => {
    const vue = pourAnnuaire(ficheComplete());
    expect(JSON.stringify(vue)).not.toContain('SECRET42');
  });

  it('ne laisse fuiter ni agent ni campagne', () => {
    const rendu = JSON.stringify(pourAnnuaire(ficheComplete()));
    expect(rendu).not.toContain('Lana KOUAKOU');
    expect(rendu).not.toContain('Conversion Glovo');
    expect(rendu).not.toContain('Rappeler après 18h');
  });

  it('garde l’identité et l’historique d’achat, qui sont le fichier client', () => {
    const vue = pourAnnuaire(ficheComplete()) as Record<string, unknown>;
    expect(vue.nom).toBe('Awa Koné');
    expect(vue.telephone).toBe('+2250700000001');
    expect(vue.customer).toEqual({ id: 'u1', first_name: 'Awa', last_name: 'Koné' });
    expect(vue.achats).toEqual({ commandes: 7, montant: 83770 });
  });

  it('conserve la forme : aucune clé ne disparaît', () => {
    const complete = ficheComplete();
    expect(Object.keys(pourAnnuaire(complete)).sort()).toEqual(Object.keys(complete).sort());
  });
});
