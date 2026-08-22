// Service worker — единственный владелец chrome.tabs / chrome.alarms (ARCHITECTURE §5).
// Правило MV3: обработчики регистрируются синхронно при загрузке модуля, ничего не хранится
// в переменных SW между холодными стартами — chrome.alarms будит воркер заново каждый раз.
import { ensureOffscreenDocument } from './ensureOffscreen.ts';
import { log } from '../../../shared/log.ts';

const HEARTBEAT_ALARM = 'heartbeat';

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== HEARTBEAT_ALARM) return;
  void ensureOffscreenDocument(chrome.offscreen).catch((err) => log.warn(`ensureOffscreenDocument: ${String(err)}`));
});
