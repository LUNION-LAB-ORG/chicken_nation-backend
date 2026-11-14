import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { EntityStatus, Prisma } from '@prisma/client';

import { donneesEffacementLivreur } from './effacement-livreur.rules';

/** Champs scalaires du modèle Deliverer, lus dans `schema.prisma`. */
function champsDuLivreur(): string[] {
  const schema = readFileSync(join(__dirname, '../../../../prisma/schema.prisma'), 'utf8');
  const bloc = schema.match(/^model Deliverer \{([\s\S]*?)^\}/m)?.[1] ?? '';
  return bloc
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//') && !l.startsWith('@@'))
    .map((l) => l.split(/\s+/))
    .filter(([, type]) => !!type && !type.endsWith('[]'))
    .filter(([nom, type]) => !(nom === 'restaurant' && type.startsWith('Restaurant')))
    .map(([nom]) => nom);
}

/** Ce qui reste volontairement après l'effacement, et pourquoi. */
const CONSERVES: Record<string, string> = {
  id: 'clé des courses passées',
  reference: 'référence interne, ne désigne personne',
  password: 'empreinte du code, inutilisable sans le téléphone effacé',
  type_vehicule: 'statistiques de flotte',
  status: 'état administratif',
  rejection_reason: 'motif administratif',
  restaurant_id: 'rattachement des courses passées',
  last_login_at: 'date technique',
  deletion_scheduled_at: 'date de la demande',
  last_available_at: 'date technique',
  pause_until: 'date technique',
  auto_pause_until: 'date technique',
  dernier_signal_at: 'date technique',
  protocole_appli: 'version technique',
  rappel_pause_at: 'date technique',
  queue_penalty_until: 'date technique',
  queue_penalty_positions: 'compteur technique',
  recent_refusals: 'compteur technique',
  created_at: 'date technique',
  updated_at: 'date technique',
};

describe('donneesEffacementLivreur (fin des 90 jours de grâce)', () => {
  const data = donneesEffacementLivreur('liv-1') as Record<string, unknown>;

  it('ferme le compte et libère le numéro', () => {
    expect(data.entity_status).toBe(EntityStatus.DELETED);
    expect(data.is_operational).toBe(false);
    expect(data.refresh_token).toBeNull();
    expect(data.phone).toBe('deleted-liv-1');
  });

  it('efface ce que promet la page publique : identité, pièces, permis, véhicule, domicile, positions', () => {
    for (const champ of [
      'first_name',
      'last_name',
      'email',
      'genre',
      'image',
      'piece_identite',
      'permis_conduire',
      'numero_permis',
      'numero_immatriculation',
      'home_address',
      'last_location_at',
      'last_speed_kmh',
      'last_heading_deg',
      'expo_push_token',
    ]) {
      expect({ champ, valeur: data[champ] }).toEqual({ champ, valeur: null });
    }
    expect(data.home_location).toBe(Prisma.DbNull);
    expect(data.last_location).toBe(Prisma.DbNull);
  });

  it('chaque champ du livreur est soit effacé, soit conservé pour une raison écrite', () => {
    const champs = champsDuLivreur();
    expect(champs.length).toBeGreaterThan(30);
    const nonClasses = champs.filter((c) => !(c in data) && !(c in CONSERVES));
    // Un champ ajouté au livreur doit être classé : effacé (règle) ou conservé (ici).
    expect(nonClasses).toEqual([]);
  });
});
