import { IsString, IsOptional, MinLength } from 'class-validator';

export class PlacesAutocompleteQueryDto {
  @IsString()
  @MinLength(1)
  input: string;

  /** Ex: `'country:ci'` pour restreindre à la Côte d'Ivoire. */
  @IsOptional()
  @IsString()
  components?: string;

  /** Langue des résultats. Défaut: `'fr'`. */
  @IsOptional()
  @IsString()
  language?: string;

  /**
   * UUID de session Places (réduit drastiquement le coût de facturation).
   * Le client doit générer un UUID par session de recherche et le réutiliser
   * pour toutes les frappes de la même session, puis en générer un nouveau
   * après chaque sélection (appel à place/details).
   */
  @IsOptional()
  @IsString()
  sessionToken?: string;
}

export class PlaceDetailsQueryDto {
  /** UUID de session — doit être le même que celui utilisé pour autocomplete. */
  @IsOptional()
  @IsString()
  sessionToken?: string;
}
