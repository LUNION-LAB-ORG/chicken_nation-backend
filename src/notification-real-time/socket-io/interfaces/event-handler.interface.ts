import { Socket } from 'socket.io';

export interface IEventHandler<T> {
    handleEvent(data: T, client: Socket): Promise<any>;
}