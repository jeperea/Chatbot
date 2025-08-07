import { createRequire } from 'module';
import qrcode from 'qrcode-terminal';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const baileys = require('@whiskeysockets/baileys');
const makeWASocket = baileys.default;               
const { useMultiFileAuthState } = baileys;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const initSession = async () => {
  const { state, saveCreds } = await useMultiFileAuthState(
    path.join(__dirname, 'auth_info')
  );

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ qr, connection, lastDisconnect }) => {
    if (qr) {
      console.log('📲 Escanea el siguiente QR con WhatsApp:\n');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      console.log('✅ Conexión con WhatsApp establecida');
    }
    if (connection === 'close') {
      console.log('❌ Conexión cerrada:', lastDisconnect?.error?.message);
    }
  });

  return sock;
};
