import { initSession } from '../sessionManager.js';
import { handleMessage } from '../handlers/messageHandler.js';

export const startWhatsAppBot = async () => {
  const sock = await initSession();

  console.log('🤖 Bot corriendo, esperando mensajes…');

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      try {
        await handleMessage(sock, msg);
      } catch (err) {
        console.error('❌ Error procesando mensaje:', err);
      }
    }
  });
};
