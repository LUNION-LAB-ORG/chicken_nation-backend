/**
 * Accès à une room Lunion renvoyé au client pour rejoindre l'appel.
 * ⚠️ Ne contient JAMAIS la clé API serveur — uniquement un token participant
 * à durée de vie courte + l'URL wss du SFU.
 */
export interface CallRoomAccess {
  room: string; // slug de la room Lunion
  token: string; // JWT participant (TTL court)
  url: string; // URL wss du SFU Lunion
  identity: string; // identité du participant dans la room
}
