import { io, type Socket } from "socket.io-client";
import { createCall, serverBase, serverOrigin, socketPath, SOCKET_OPTIONS } from "@bargames/gamekit/client";

// In dev, Vite serves the client on :5195 while the server runs on :3015. In production the
// server serves the built client itself (one origin). Under a path prefix (a box's
// https://<venue>/zinger/) `serverUrl` carries it; socket.io takes the bare origin plus
// a `path` (a URL's path would be read as a namespace).
const dev = { vitePort: 5195, serverPort: 3015 };
export const serverUrl = serverBase(dev);

// WebSocket first (the kit's SOCKET_OPTIONS): long-polling first lost early emits through
// Cloudflare Tunnel in the sibling games.
export const socket: Socket = io(serverOrigin(dev), { ...SOCKET_OPTIONS, path: socketPath() });

const kitCall = createCall(socket as unknown as Parameters<typeof createCall>[0]);

/** Emit with an ack as a promise. Rejects with the server's error message. */
export function call<T = object>(event: string, ...args: unknown[]): Promise<T> {
  return kitCall<T>(event, ...args);
}
