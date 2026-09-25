import { NotificationTarget, UserRole } from '@prisma/client';
import {
  NOTIFICATIONS_PAGE_DEFAULT,
  NOTIFICATIONS_PAGE_MAX,
  NOTIFICATIONS_PAGE_NUMBER_MAX,
  normalizeNotificationPagination,
  notificationOwnerOf,
  ownsNotifications,
} from './notification-owner.util';

const MEMBRE_ID = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID = '22222222-2222-4222-8222-222222222222';

describe('notificationOwnerOf', () => {
  it('un membre du personnel (ligne User, avec un role) possède la cible USER', () => {
    expect(notificationOwnerOf({ id: MEMBRE_ID, role: UserRole.CAISSIER })).toEqual({
      user_id: MEMBRE_ID,
      target: NotificationTarget.USER,
    });
  });

  it('un client (ligne Customer, sans role) possède la cible CUSTOMER', () => {
    expect(notificationOwnerOf({ id: CLIENT_ID, phone: '+2250700000000' })).toEqual({
      user_id: CLIENT_ID,
      target: NotificationTarget.CUSTOMER,
    });
  });

  it('un role présent mais vide désigne quand même le personnel, comme getAuthType', () => {
    expect(notificationOwnerOf({ id: MEMBRE_ID, role: undefined })?.target).toBe(NotificationTarget.USER);
  });

  it('renvoie null sans principal ou sans identifiant exploitable', () => {
    expect(notificationOwnerOf(undefined)).toBeNull();
    expect(notificationOwnerOf(null)).toBeNull();
    expect(notificationOwnerOf('jeton')).toBeNull();
    expect(notificationOwnerOf({})).toBeNull();
    expect(notificationOwnerOf({ id: '' })).toBeNull();
    expect(notificationOwnerOf({ id: 42, role: UserRole.ADMIN })).toBeNull();
  });
});

describe('ownsNotifications', () => {
  const membre = { user_id: MEMBRE_ID, target: NotificationTarget.USER };
  const client = { user_id: CLIENT_ID, target: NotificationTarget.CUSTOMER };

  it('accepte le couple exact du jeton', () => {
    expect(ownsNotifications(membre, MEMBRE_ID, NotificationTarget.USER)).toBe(true);
    expect(ownsNotifications(client, CLIENT_ID, NotificationTarget.CUSTOMER)).toBe(true);
  });

  it("refuse l'identifiant d'un autre", () => {
    expect(ownsNotifications(membre, CLIENT_ID, NotificationTarget.USER)).toBe(false);
    expect(ownsNotifications(client, MEMBRE_ID, NotificationTarget.CUSTOMER)).toBe(false);
  });

  it('refuse le bon identifiant avec la mauvaise cible', () => {
    expect(ownsNotifications(membre, MEMBRE_ID, NotificationTarget.CUSTOMER)).toBe(false);
    expect(ownsNotifications(client, CLIENT_ID, NotificationTarget.USER)).toBe(false);
  });

  it('refuse sans propriétaire', () => {
    expect(ownsNotifications(null, MEMBRE_ID, NotificationTarget.USER)).toBe(false);
  });
});

describe('normalizeNotificationPagination', () => {
  it("prend la page 1 et la taille par défaut quand rien n'est demandé", () => {
    expect(normalizeNotificationPagination(undefined, undefined)).toEqual({
      page: 1,
      limit: NOTIFICATIONS_PAGE_DEFAULT,
      skip: 0,
    });
  });

  it('garde une demande raisonnable telle quelle', () => {
    expect(normalizeNotificationPagination(3, 10)).toEqual({ page: 3, limit: 10, skip: 20 });
  });

  it("plafonne sans refuser : l'appli demande limit=1000 et reçoit les 100 plus récentes", () => {
    expect(normalizeNotificationPagination(1, 1000)).toEqual({
      page: 1,
      limit: NOTIFICATIONS_PAGE_MAX,
      skip: 0,
    });
    expect(NOTIFICATIONS_PAGE_MAX).toBe(100);
  });

  it('ramène une page nulle ou négative à 1 (plus de skip négatif)', () => {
    expect(normalizeNotificationPagination(0, 10).skip).toBe(0);
    expect(normalizeNotificationPagination(-4, 10)).toEqual({ page: 1, limit: 10, skip: 0 });
  });

  it('plafonne une page démesurée : le décalage reste un entier que la base accepte', () => {
    const res = normalizeNotificationPagination(1e20, 100);
    expect(res.page).toBe(NOTIFICATIONS_PAGE_NUMBER_MAX);
    expect(res.skip).toBe((NOTIFICATIONS_PAGE_NUMBER_MAX - 1) * 100);
    expect(Number.isSafeInteger(res.skip)).toBe(true);
    expect(normalizeNotificationPagination(Infinity, 10).page).toBe(1);
  });

  it('ignore une taille nulle, négative ou illisible', () => {
    expect(normalizeNotificationPagination(1, 0).limit).toBe(NOTIFICATIONS_PAGE_DEFAULT);
    expect(normalizeNotificationPagination(1, -5).limit).toBe(NOTIFICATIONS_PAGE_DEFAULT);
    expect(normalizeNotificationPagination('abc', 'xyz')).toEqual({
      page: 1,
      limit: NOTIFICATIONS_PAGE_DEFAULT,
      skip: 0,
    });
  });

  it("accepte les chaînes et arrondit à l'entier inférieur", () => {
    expect(normalizeNotificationPagination('2', '25')).toEqual({ page: 2, limit: 25, skip: 25 });
    expect(normalizeNotificationPagination(2.7, 10.9)).toEqual({ page: 2, limit: 10, skip: 10 });
  });
});
