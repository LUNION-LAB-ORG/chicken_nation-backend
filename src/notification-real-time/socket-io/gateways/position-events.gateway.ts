import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import { Server, Socket } from "socket.io";

interface I_Position {
  id: string;
  lat: string;
  long: string;
}

@WebSocketGateway({
  namespace: "position-socket-event",
  cors: {
    origin: "*",
  },
})
export class PositionEventsGateway {

  @WebSocketServer()
  server: Server;

  // Lors de la connexion du client
  handleConnection(client: Socket) {
    console.log(`Client connecté : ${client.id}`);
  }

  // Lors de la déconnexion du client
  handleDisconnection(client: Socket) {
    console.log(`Client déconnecté : ${client.id}`);
  }

  // Gérer les évènements dans le salon "position" avec les données de l'utilisateur connecté qui les envois
  @SubscribeMessage("position")
  async handleMessageEvent(
    @MessageBody() data: I_Position,
    @ConnectedSocket() client: Socket
  ) {
    console.log(`client ${client.id} a envoyé : ${data}`);

    // Envoie une réponse
    this.server.emit("position-serveur", { client: client.id, data: data });
    return {
      status: "success",
      message: "Position envoyée avec succès",
    };
  }
}
