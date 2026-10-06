import { masquerContacts, masquerEmail, masquerTelephone } from './masquer-contact';

describe('masquer les coordonnées', () => {
  it('garde la fin du numéro, pour distinguer deux personnes dans une liste', () => {
    expect(masquerTelephone('+2250140735992')).toBe('+225••••••••92');
    expect(masquerTelephone('0140735992')).toBe('••••••••92');
  });

  it('garde le domaine de l’adresse, et ne laisse rien du reste', () => {
    expect(masquerEmail('monemailpro2007@gmail.com')).toBe('mon•••@gmail.com');
    expect(masquerEmail('monemailpro2007@gmail.com')).not.toContain('2007');
  });

  it('masque un numéro trop court sans le laisser passer', () => {
    expect(masquerTelephone('123')).toBe('•••');
  });

  /**
   * Le test qui compte : il cherche la valeur dans la réponse ENTIÈRE, pas
   * seulement dans les champs auxquels on a pensé. C'est ce qui attrapera le
   * jour où quelqu'un imbriquera le client une couche plus bas.
   */
  it('masque à toutes les profondeurs, listes comprises', () => {
    const reponse = {
      data: [
        {
          id: 'c1',
          customer: { first_name: 'Yasmine', phone: '+2250140735992', email: 'monemailpro2007@gmail.com' },
          demande: { contact: { phone: '+2250758375865' } },
        },
      ],
      meta: { total: 1 },
    };
    const rendu = JSON.stringify(masquerContacts(reponse));
    expect(rendu).not.toContain('0140735992');
    expect(rendu).not.toContain('0758375865');
    expect(rendu).not.toContain('monemailpro2007');
    // Ce qui n'est pas une coordonnée ne bouge pas.
    expect(rendu).toContain('Yasmine');
    expect(rendu).toContain('"total":1');
  });

  /**
   * Le masquage traverse une réponse sur dix ; il ne doit rien casser sur les
   * neuf autres. Reconstruire champ par champ un tampon ou un montant Prisma
   * rendrait un objet nu, privé de ses méthodes : le fichier exporté
   * arriverait illisible et le montant se sérialiserait en « {} ».
   */
  it('laisse intact ce qui n’est pas un objet simple', () => {
    const tampon = Buffer.from('classeur');
    class Montant {
      constructor(private readonly v: string) { }
      toString() { return this.v; }
      toJSON() { return this.v; }
    }
    const montant = new Montant('12500');
    const r = masquerContacts({ tampon, montant, phone: '+2250140735992' }) as {
      tampon: Buffer; montant: Montant; phone: string;
    };
    expect(Buffer.isBuffer(r.tampon)).toBe(true);
    expect(r.tampon.toString()).toBe('classeur');
    expect(r.montant).toBeInstanceOf(Montant);
    expect(JSON.stringify(r.montant)).toBe('"12500"');
    // La coordonnée voisine est bien masquée, elle.
    expect(r.phone).toBe('+225••••••••92');
  });

  it('ne casse ni les dates ni les valeurs nulles', () => {
    const d = new Date('2026-10-04T00:00:00.000Z');
    const r = masquerContacts({ date: d, rien: null, n: 3 }) as { date: Date; rien: null; n: number };
    expect(r.date).toBe(d);
    expect(r.rien).toBeNull();
    expect(r.n).toBe(3);
  });
});
