import type { Member } from '../client/types';
export interface AdminRoom {
  id: string; name: string; hostNickname: string; members: Member[];
  maxParticipants: number; createdAt: string; pendingAdmissions: number;
  activeAdminListeners: number; adminListeningAvailable: boolean;
  hostReconnectDeadline?: string; emptyDeadline?: string; hostDisconnectTimeoutMinutes: number;
}
export interface Overview {
  instance: { name: string; maximumRooms: number; uptimeMs: number };
  totals: { rooms: number; connectedMembers: number; members: number };
  rooms: AdminRoom[]; now: string;
}
export interface ListenerGrant { listenerId: string; e2eeKey: string; livekitUrl: string; livekitToken: string }
