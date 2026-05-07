export interface ConnectedUser {
    id: string;
    type: 'customer' | 'user' | 'deliverer';
    userType?: 'BACKOFFICE' | 'RESTAURANT';
    restaurantId?: string;
    socketId: string;
}