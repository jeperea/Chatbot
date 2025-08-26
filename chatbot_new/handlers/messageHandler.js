import { handleAcademicMessage } from '../services/postgresService.js';

export async function handleMessage(sock, msg) {
  const chatId = msg.key.remoteJid;
  const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
  if (!text.trim()) return;

  const reply = await handleAcademicMessage(chatId, text.trim());
  if (reply) {
    await sock.sendMessage(chatId, { text: reply });
  }
}
