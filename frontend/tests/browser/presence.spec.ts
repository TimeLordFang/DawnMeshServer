import { test, expect } from '@playwright/test';
import { enterRoom } from './fixture';

test('media membership overrides control disconnect and clears offline badges on recovery', async ({ page }) => {
  const fixture = await enterRoom(page);
  fixture.sendManagementEvent({type: 'snapshot', hostMemberId: 'me', members: [
    {id:'me', nickname:'林间', isHost:true, connected:true, canSpeak:true},
    {id:'river', nickname:'小河', connected:false, canSpeak:true},
  ]});
  const peer = page.locator('.member-card').filter({hasText:'小河'});
  await expect(peer).toBeVisible();
  await expect(peer.locator('.offline-badge')).toHaveCount(0);
  await page.evaluate(() => {
    const room = (window as any).__room;
    room.remoteParticipants.delete('river'); room.emit('ParticipantDisconnected');
  });
  await expect(peer.locator('.offline-badge')).toBeVisible();
  await page.evaluate(() => {
    const room = (window as any).__room;
    room.remoteParticipants.set('river',{identity:'river'}); room.emit('ParticipantConnected');
  });
  await expect(peer.locator('.offline-badge')).toHaveCount(0);
  await page.evaluate(() => {
    const room = (window as any).__room;
    room.state = 'reconnecting'; room.remoteParticipants.clear(); room.emit('Reconnecting');
  });
  fixture.sendManagementEvent({type:'snapshot',hostMemberId:'me',members:[
    {id:'me',nickname:'林间',isHost:true,connected:true}, {id:'river',nickname:'小河',connected:false},
  ]});
  await expect(peer.locator('.offline-badge')).toHaveCount(0);
  await page.evaluate(() => {
    const room = (window as any).__room;
    room.state = 'connected'; room.remoteParticipants.set('river',{identity:'river'}); room.emit('Reconnected');
  });
  await expect(peer.locator('.offline-badge')).toHaveCount(0);
});
