export interface ConnectedUser {
    id: string;
    type: 'customer' | 'user';
    userType?: 'BACKOFFICE' | 'RESTAURANT';
    restaurantId?: string;
    socketId: string;
}