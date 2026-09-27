import type { ActiveRoom, Member } from './types';

// A fresh channel starts from a quiet baseline; historical absences never speak.
let owner: ActiveRoom | null = null;
let ready = false;
let previous = new Map<string, boolean>();
const pending = new Map<string, ReturnType<typeof setTimeout>>();
const seen = new Set<string>();
let lastSpoken = 0;

export function resetPresence(active: ActiveRoom) {
  for (const timer of pending.values()) clearTimeout(timer);
  pending.clear(); previous.clear(); ready = false;
  if (owner !== active) seen.clear();
  owner = active;
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
}

function speak(active: ActiveRoom, name: string, left: boolean) {
  if (owner !== active || !active.summary.presenceAnnouncementsEnabled || active.leaving || active.roomEnded) return;
  if (!('speechSynthesis' in window) || Date.now() - lastSpoken < 1500) return;
  const voice = window.speechSynthesis.getVoices().find(v => v.localService && v.lang.startsWith('zh'));
  if (!voice) return; // Browsers without an installed voice keep the visual status.
  lastSpoken = Date.now();
  const clean = name.split('#')[0].replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24) || '一位成员';
  const utterance = new SpeechSynthesisUtterance(`${clean}${left ? '已退出房间' : '已掉线'}`);
  utterance.voice = voice; utterance.lang = voice.lang; utterance.volume = 0.7;
  window.speechSynthesis.cancel(); window.speechSynthesis.speak(utterance);
}

export function observePresence(active: ActiveRoom, members: Member[]) {
  if (owner !== active) resetPresence(active);
  const next = new Map(members.map(m => [m.id, m.connected !== false]));
  for (const m of members) {
    if (m.connected !== false) { clearTimeout(pending.get(m.id)); pending.delete(m.id); }
    else if (ready && previous.get(m.id) === true && m.id !== active.memberId && active.summary.presenceAnnouncementsEnabled) {
      clearTimeout(pending.get(m.id));
      pending.set(m.id, setTimeout(() => {
        pending.delete(m.id);
        if (previous.get(m.id) === false) speak(active, m.nickname, false);
      }, 2000));
    }
  }
  for (const id of previous.keys()) if (!next.has(id)) { clearTimeout(pending.get(id)); pending.delete(id); }
  previous = next; ready = true;
  if (!active.summary.presenceAnnouncementsEnabled) {
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  }
}

export function memberLeft(active: ActiveRoom, id: string, name: string, eventId: string) {
  if (!ready || owner !== active || id === active.memberId || !eventId || seen.has(eventId)) return;
  seen.add(eventId); if (seen.size > 256) seen.delete(seen.values().next().value!);
  clearTimeout(pending.get(id)); pending.delete(id);
  speak(active, name, true);
}

const displayedOnline = new WeakMap<ActiveRoom, Map<string, boolean>>();
export function displayMembers(active: ActiveRoom): Member[] {
  const previous = displayedOnline.get(active) ?? new Map<string, boolean>();
  const room = active.room;
  const ids = room?.state === 'connected'
    ? new Set([active.memberId, ...Array.from(room.remoteParticipants.values(), p => p.identity)]) : null;
  const members = active.members.map(m => ({...m,
    connected: ids ? ids.has(m.id) : (previous.get(m.id) ?? true),
  }));
  displayedOnline.set(active, new Map(members.map(m => [m.id, m.connected])));
  return members;
}
