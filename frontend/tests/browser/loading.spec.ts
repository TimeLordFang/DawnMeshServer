import { test, expect } from '@playwright/test';
import { setupRoom } from './fixture';

test('room list remains usable without loading the media SDK', async ({ page }) => {
  await setupRoom(page);
  const mediaRequests: string[] = [];
  page.on('request', request => {
    if (/\/node_modules\/\.vite\/deps\/livekit-client\.js/.test(request.url())) mediaRequests.push(request.url());
  });
  await page.goto('/ui/client/');
  await page.getByLabel('昵称', { exact: true }).fill('林间');
  await page.getByRole('button', { name: '连接服务器' }).click();
  await expect(page.getByRole('button', { name: '＋ 创建房间' })).toBeVisible();
  expect(mediaRequests).toEqual([]);
});

test('admin dashboard remains usable without loading the media SDK', async ({ page }) => {
  await setupRoom(page);
  const mediaRequests: string[] = [];
  page.on('request', request => {
    if (/\/node_modules\/\.vite\/deps\/livekit-client\.js/.test(request.url())) mediaRequests.push(request.url());
  });
  await page.addInitScript(() => sessionStorage.setItem('dawnmesh-admin-token', 'test-admin-token'));
  await page.goto('/ui/admin/');
  await expect(page.locator('#dashboard-view')).toBeVisible();
  await expect(page.locator('#rooms')).toContainText('山海骑行小队');
  expect(mediaRequests).toEqual([]);
});
