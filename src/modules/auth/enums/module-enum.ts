export enum Modules {
  DASHBOARD = 'dashboard',
  COMMANDES = 'orders',
  MENUS = 'menus',
  MARKETING = 'marketing',
  CLIENTS = 'clients',
  INVENTAIRE = 'inventory',
  RESTAURANTS = 'restaurants',
  PERSONNELS = 'personnel',
  LIVREURS = 'livreurs',
  PROMOTIONS = 'promos',
  FIDELITE = 'loyalty',
  MESSAGES = 'inbox',
  CARD_NATION = 'card_nation',
  COMMENTAIRES = 'reviews',
  SETTINGS = 'settings',
  BASE_DONNEES = 'base_donnees',
  /** Conversion des inscrits qui n'ont jamais commandé (module Prospects). */
  CRM = 'crm',
  CALLS = 'calls',
  /** Page Notifications (campagnes push) : séparée de SETTINGS pour l'ouvrir sans ouvrir Paramètres. */
  NOTIFICATIONS = 'notifications',
  /** Diffusions de messages : séparées de MARKETING pour que le menu Marketing puisse être en lecture seule. */
  DIFFUSIONS = 'broadcasts',
  AUDIT = 'audit',
  ALL = 'all',
}