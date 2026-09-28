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

test('host waits for media grant without a false moderator mute and recovers speaking', async ({ page }) => {
  await enterRoom(page);
  await page.locator('#enable-audio-devices').click();
  await expect(page.locator('#audio-device-title')).toHaveText('麦克风已就绪');
  await page.evaluate(() => {
    const room=(window as any).__room;
    room.localParticipant.identity='me';room.localParticipant.permissions.canPublish=false;
    room.emit('ParticipantPermissionsChanged',{},room.localParticipant);
  });
  await expect(page.locator('#talk-label')).toHaveText('正在恢复发言权限');
  await expect(page.getByText('已被房主封麦',{exact:true})).toHaveCount(0);
  await page.evaluate(() => {
    const room=(window as any).__room;
    room.localParticipant.permissions.canPublish=true;
    room.emit('ParticipantPermissionsChanged',{},room.localParticipant);
  });
  await expect(page.locator('#talk-label')).toHaveText('按住说话');
});
