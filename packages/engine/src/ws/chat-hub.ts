import type { WebSocket } from '@fastify/websocket';
import type { ServerEvent } from '../protocol.js';

/** Tracks open WebSockets per group and pushes events to them. */
export class ChatHub {
  private readonly socketsByGroup = new Map<string, Set<WebSocket>>();

  add(groupId: string, socket: WebSocket): void {
    let sockets = this.socketsByGroup.get(groupId);
    if (!sockets) {
      sockets = new Set();
      this.socketsByGroup.set(groupId, sockets);
    }
    sockets.add(socket);
    socket.once('close', () => this.remove(groupId, socket));
  }

  remove(groupId: string, socket: WebSocket): void {
    const sockets = this.socketsByGroup.get(groupId);
    if (!sockets) return;
    sockets.delete(socket);
    if (sockets.size === 0) this.socketsByGroup.delete(groupId);
  }

  broadcast(groupId: string, event: ServerEvent): void {
    const sockets = this.socketsByGroup.get(groupId);
    if (!sockets) return;
    const payload = JSON.stringify(event);
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  }

  connectionCount(groupId: string): number {
    return this.socketsByGroup.get(groupId)?.size ?? 0;
  }
}
