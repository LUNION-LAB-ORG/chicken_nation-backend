export const turboServiceMock = {
  creerCourse: jest.fn().mockResolvedValue(null), // renvoie null par défaut
  obtenirFraisLivraison: jest.fn().mockResolvedValue([]), // renvoie une liste vide
  obtenirFraisLivraisonParRestaurant: jest.fn().mockResolvedValue(null),
  getPrixLivraison: jest.fn().mockImplementation((distanceKm: number) => distanceKm * 100), // exemple simple
};
