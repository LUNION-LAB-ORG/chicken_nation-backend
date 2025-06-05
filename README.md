## TODO : NOTIFICATION

- Notification en temps réel


/ ================================
// 4. TYPES POUR LE FRONTEND
// ================================

// Types TypeScript pour le frontend
export interface OrderWebSocketEvents {
  'order:created': (data: { order: Order; message: string }) => void;
  'order:status_updated': (data: { 
    order: Order; 
    message: string; 
    previousStatus?: string 
  }) => void;
  'order:updated': (data: { order: Order; message: string }) => void;
  'order:deleted': (data: { orderId: string; message: string }) => void;
}

export interface OrderWebSocketClientEvents {
  ping: () => void;
}

// ================================
// 5. EXEMPLE D'UTILISATION CÔTÉ CLIENT
// ================================

/*
// Frontend - Connexion WebSocket
import { io } from 'socket.io-client';

//
// https://chicken.turbodeliveryapp.com/orders/all

// CONNEXION PERMANENTE AVEC LE SERVEUR
const socket = io('https://chicken.turbodeliveryapp.com/orders', {
  query: {
    type:"customer"|"user"
  },
  extraHeaders: {
    Authorization: `Bearer ${token}`
  }
});

// Écouter les événements
socket.on('order:created', (data: OrderWebSocketEvents) => {
  console.log('Nouvelle commande:', data.order);
  // Mettre à jour l'interface utilisateur
});

socket.on('order:status_updated', (data: OrderWebSocketEvents) => {
  console.log('Statut mis à jour:', data.order.status);
  // Mettre à jour l'interface utilisateur
});

socket.on('order:updated', (data) => {
  console.log('Commande mise à jour:', data.order);
  // Mettre à jour l'interface utilisateur
});

socket.on('order:deleted', (data) => {
  console.log('Commande supprimée:', data.orderId);
  // Retirer de l'interface utilisateur
});

// lancer une requête de ping pour vérifier la connexion
socket.emit('ping');

// recevoir la réponse pong
socket.on('pong', (data) => {
  console.log('Pong reçu', data);
});


*/