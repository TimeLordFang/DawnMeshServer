import type { Room, LocalAudioTrack } from 'livekit-client';
import type { Bytes, ChatCipher, PakeKeys } from './crypto';
import type { MicrophoneGate } from '../shared/microphone-gate';
export interface RoomSummary { id: string; name: string; hostNickname: string; memberCount: number; maxParticipants: number; isHost: boolean; adminListening: boolean }
export interface Member { id: string; nickname: string; canSpeak: boolean; isHost: boolean; connected: boolean; reconnectDeadline?: string }
export interface Grant { memberId: string; resumeToken: string; eventsUrl: string; livekitUrl: string; livekitToken: string; room: RoomSummary }
export interface Admission { admissionId: string; memberId: string; resumeToken: string; eventsUrl: string }
export interface EnterRoom { grant: Grant; roomKey: Bytes; inviteCode: string; inviteScalar: bigint; chatCipher?: ChatCipher | null }
export interface ServerInfo { protocolVersion: number; instanceId: string; name: string; maxRoomParticipants: number; adminListeningSupported: boolean }
export interface ManagementEvent { type: string; room: RoomSummary; hostMemberId: string; memberId: string; canSpeak: boolean; members: Member[]; body: string; admissionId: string; connection: Grant; error: string }
export interface EventChannel {
  readyState: number; intentional?: boolean; transport?: string;
  addEventListener(type: string, callback: EventListener, options?: AddEventListenerOptions): void;
  removeEventListener(type: string, callback: EventListener, options?: EventListenerOptions): void;
  send(data: string): void; close(code?: number, reason?: string): void;
}
export interface ChatMessage { id: string; senderId: string; senderName: string; text: string; sentAt: number; mine: boolean }
export interface ActiveRoom extends EnterRoom {
  memberId: string; resumeToken: string; summary: RoomSummary; members: Member[];
  isHost: boolean; canSpeak: boolean; muted: boolean; voiceMode: 'ptt' | 'auto'; ptt: boolean;
  audioProfile: string; speaking: Set<string>; messages: ChatMessage[];
  hostAdmissions: Map<string, { keys: PakeKeys; created: number }>; chatCipher: ChatCipher;
  socket: EventChannel | null; room: Room | null; worker: Worker | null; leaving: boolean;
  eventsReconnectTimer: number | undefined; mediaReconnectTimer: number | undefined;
  mediaReconnectAttempts: number; mediaReconnectStarted: number; lastMediaError: string;
  microphonePermissionVerified: boolean; microphoneError: string; audioReady: boolean;
  audioInitializing: boolean; audioInputId: string; audioOutputId: string;
  audioInputCount: number; audioOutputCount: number; remoteAudioTracks: number;
  mediaDiagnostic: string; fullReconnectTimer: number | undefined; fullReconnectStarted: number;
  inviteVisible: boolean; inviteTimer: number | undefined; intentionalMediaDisconnects?: WeakSet<Room>;
  micTrack?: LocalAudioTrack; micGate?: MicrophoneGate; micTask?: Promise<void>; audioGeneration: number; playbackBlocked: boolean;
}
export interface ClientState {
  accessToken: string; nickname: string; deviceId: string; info: ServerInfo | null;
  roomsTimer: number | undefined; active: ActiveRoom | null; toastTimer: number | undefined;
  wakeLock: WakeLockSentinel | null; preferHTTPEvents: boolean;
}
