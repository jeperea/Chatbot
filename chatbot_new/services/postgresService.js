import { pool } from '../config/db.js';
import i18next from '../config/i18next.js';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Secret key para registrar/login admin
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'CHANGE_ME_ADMIN_SECRET';

// ---------- Helpers ----------
function getCurrentSemester() {
  // Si existe y no está vacío, usar FORCE_SEMESTER
  if (process.env.FORCE_SEMESTER && process.env.FORCE_SEMESTER.trim() !== "") {
    return process.env.FORCE_SEMESTER.trim();
  }

  // Si no, calcular dinámicamente por la fecha
  const now = new Date();
  const year = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Bogota',
    year: 'numeric'
  }).format(now);

  const monthStr = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Bogota',
    month: 'numeric'
  }).format(now);

  const month = parseInt(monthStr, 10);
  const sem = (month >= 1 && month <= 6) ? '1' : '2';

  return `${year}-${sem}`;
}

// Comprueba si la columna usuario.carrera_id existe (cache simple)
let _hasUsuarioCarreraId = null;
async function usuarioHasCarreraIdColumn() {
  if (_hasUsuarioCarreraId !== null) return _hasUsuarioCarreraId;
  try {
    const res = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'usuario' AND column_name = 'carrera_id'
    `);
    _hasUsuarioCarreraId = res.rows.length > 0;
  } catch (e) {
    // si falla (por permisos o db no soporta information_schema), asumimos false
    _hasUsuarioCarreraId = false;
  }
  return _hasUsuarioCarreraId;
}

// Obtener carrera del usuario con fallback: usuario.carrera_id -> matricula_carrera reciente
async function getCareerForUserByEmail(correo) {
  // devuelve { id, nombre } o null
  try {
    const hasCol = await usuarioHasCarreraIdColumn();
    if (hasCol) {
      const ures = await pool.query('SELECT carrera_id FROM usuario WHERE correo = $1 LIMIT 1', [correo]);
      if (ures.rows.length && ures.rows[0].carrera_id) {
        const cRes = await pool.query('SELECT id, nombre FROM carrera WHERE id = $1 LIMIT 1', [ures.rows[0].carrera_id]);
        if (cRes.rows.length) return { id: cRes.rows[0].id, nombre: cRes.rows[0].nombre };
      }
    }

    // fallback: buscar por matricula -> matricula_carrera (la más reciente)
    const userRes = await pool.query(
      `SELECT c.id AS carrera_id, c.nombre AS carrera_nombre
       FROM usuario u
       LEFT JOIN matricula m ON m.usuario_id = u.id
       LEFT JOIN matricula_carrera mc ON mc.matricula_id = m.id
       LEFT JOIN carrera c ON c.id = mc.carrera_id
       WHERE u.correo = $1
       ORDER BY m.semestre DESC
       LIMIT 1`,
      [correo]
    );
    if (userRes.rows.length && userRes.rows[0].carrera_id) {
      return { id: userRes.rows[0].carrera_id, nombre: userRes.rows[0].carrera_nombre };
    }
    return null;
  } catch (err) {
    console.error('getCareerForUserByEmail error:', err);
    return null;
  }
}

// Simple validations
function isValidCedula(s) {
  return /^\d+$/.test(s);
}
function isValidEmail(s) {
  // requisito del usuario: contener '@'
  return typeof s === 'string' && s.includes('@');
}

// ---------- PDF generator ----------
async function generatePensumPDFBase64(pensumRows = [], careerName = 'Career', studentName = 'Student', lng = 'es') {
  return new Promise(async (resolve, reject) => {
    try {
      const t = (k, opts) => i18next.t(k, { lng, ...opts });

      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => {
        const result = Buffer.concat(chunks);
        resolve({
          filename: `pensum_${careerName.replace(/\s+/g, '_')}.pdf`,
          mime: 'application/pdf',
          base64: result.toString('base64')
        });
      });

      // Header: logo
      const logoPath = path.join(__dirname, '../assets/usc_logo.png');
      if (fs.existsSync(logoPath)) {
        try { doc.image(logoPath, 50, 45, { width: 90 }); } catch (e) { /* ignore */ }
      }

      // University name (translated) and extra header text
      doc.fontSize(14).text(t('university_name'), 160, 50, { align: 'left' });
      doc.moveDown(0.5);
      doc.fontSize(10).text(t('director_title'), { align: 'left' });

      // Title central (pensum)
      doc.moveDown(1.2);
      doc.fontSize(12).text(t('pensum_title'), { align: 'center', underline: true });

      // Datos estudiante / carrera
      doc.moveDown(0.8);
      doc.fontSize(10).text(`${t('label_student')}: ${studentName}`);
      doc.text(`${t('label_career')}: ${careerName}`);
      doc.moveDown(0.5);

      // Tabla simple
      const startX = 50;
      let y = doc.y;
      const col = {
        code: startX,
        name: startX + 80,
        level: startX + 360,
        credits: startX + 420,
        hours: startX + 480
      };

      doc.fontSize(9).text(t('table_code'), col.code, y);
      doc.text(t('table_subject'), col.name, y);
      doc.text(t('table_level'), col.level, y);
      doc.text(t('table_credits'), col.credits, y);
      doc.text(t('table_hours'), col.hours, y);

      y += 18;
      let totalCredits = 0;
      doc.fontSize(9);

      pensumRows.forEach((r) => {
        if (y > 720) { doc.addPage(); y = 50; }
        doc.text(r.codigo || '', col.code, y);
        doc.text(r.nombre || '', col.name, y, { width: 260 });
        doc.text(String(r.nivel ?? ''), col.level, y);
        doc.text(String(r.creditos ?? ''), col.credits, y);
        doc.text(String(r.horas ?? ''), col.hours, y);
        y += 18;
        totalCredits += Number(r.creditos || 0);
      });

      // Línea y total
      if (y + 40 > 780) { doc.addPage(); y = 50; }
      doc.moveTo(startX, y + 6).lineTo(550, y + 6).stroke();
      doc.fontSize(10).text(`${t('total_credits')}: ${totalCredits}`, startX, y + 14);

      // Firma + QR
      const qrData = `pensum:${careerName}:${Date.now()}`;
      let qrBuffer = null;
      try {
        qrBuffer = await QRCode.toBuffer(qrData, { type: 'png', margin: 1, width: 160 });
      } catch (e) {
        // si falla QR, continuamos sin él
        console.warn('QRCode generation failed:', e);
      }

      // Firma
      const firmaPath = path.join(__dirname, '../assets/firma.png');
      if (fs.existsSync(firmaPath)) {
        try { doc.image(firmaPath, startX, y + 60, { width: 120 }); } catch (e) { /* ignore */ }
      } else {
        doc.fontSize(9).text(t('director_name'), startX, y + 110);
        doc.fontSize(8).text(t('director_title'), startX, y + 124);
      }

      // QR a la derecha
      if (qrBuffer) {
        const qrX = 460;
        const qrY = y + 60;
        try { doc.image(qrBuffer, qrX, qrY, { width: 80 }); } catch (e) { /* ignore */ }
      }

      // Footer
      doc.fontSize(8).text(t('footer_address'), 50, 780, { align: 'center', width: 500 });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ---------- Main handler ----------
export async function handleAcademicMessage(waId, text) {
  // Inicializar o recuperar sesión
  let session = sessionStates.get(waId);
  if (!session) {
    session = {
      estado: null,
      step: 0,
      data: {},
      lng: 'es',
      roleIntent: null,
      expectAdminSecret: false,
      isAdminKeyVerified: false,
      userRole: null
    };
    sessionStates.set(waId, session);
  }

  // Helper de traducción
  const t = (key, opts) => i18next.t(key, { lng: session.lng, ...opts });
  text = (text || '').trim();
  const lower = text.toLowerCase().trim();

  // Comandos de cambio de idioma
  if (lower === 'lang en' || lower === 'idioma en') {
    session.lng = 'en';
    return t('lang_switched', { lng: 'en' });
  }
  if (lower === 'lang es' || lower === 'idioma es') {
    session.lng = 'es';
    return t('lang_switched', { lng: 'es' });
  }

  // --- MENÚ INICIAL Y FLUJOS DE ROL ---
  if (!session.roleIntent && !session.estado && !session.expectAdminSecret) {
    if (['1', '1)', 'one'].includes(lower)) {
      session.roleIntent = 'student';
      return `${t('bot_student_welcome')}\n- ${t('opt_registered')}\n- ${t('opt_register')}`;
    }
    if (['2', '2)', 'two'].includes(lower)) {
      session.roleIntent = 'admin';
      session.expectAdminSecret = true;
      return t('bot_admin_secret_prompt');
    }
    return [
      t('bot_intro_line1'),
      t('bot_intro_line2'),
      '',
      t('bot_choose_option'),
      `1) ${t('bot_option_student')}`,
      `2) ${t('bot_option_admin')}`,
      '',
      t('bot_language_instruction')
    ].join('\n');
  }

  // Si estamos esperando la clave secreta de admin
  if (session.expectAdminSecret && !session.isAdminKeyVerified) {
    if (text === ADMIN_SECRET) {
      session.isAdminKeyVerified = true;
      session.expectAdminSecret = false;
      return `${t('bot_admin_verified')}\n- ${t('opt_registered')}\n- ${t('opt_register')}`;
    } else {
      session.roleIntent = null;
      session.expectAdminSecret = false;
      return t('bot_admin_secret_invalid');
    }
  }

  // --- FLUJO registro / login / verificación ---
  if (!session.estado) {
    if (lower === t('opt_registered')) {
      if (session.roleIntent === 'admin' && !session.isAdminKeyVerified) {
        session.roleIntent = null;
        return t('bot_admin_must_verify');
      }
      session.estado = 'verificando';
      session.step = 1;
      return t('ask_email');
    }
    if (lower === t('opt_register')) {
      if (session.roleIntent === 'admin' && !session.isAdminKeyVerified) {
        session.expectAdminSecret = true;
        return t('bot_admin_secret_prompt');
      }
      session.estado = 'registro';
      session.step = 1;
      return t('ask_name');
    }
    return `${t('welcome')}\n- ${t('opt_registered')}\n- ${t('opt_register')}`;
  }

  // 1.a) Verificación de usuario existente
  if (session.estado === 'verificando') {
    if (session.step === 1) {
      const emailInput = text;
      if (!isValidEmail(emailInput)) return t('error_invalid_email');
      session.data.correo = emailInput;
      session.step = 2;
      return t('ask_id');
    }
    if (session.step === 2) {
      const cedulaInput = text;
      if (!isValidCedula(cedulaInput)) return t('error_invalid_cedula');
      session.data.cedula = cedulaInput;

      const result = await pool.query('SELECT * FROM usuario WHERE correo=$1 AND cedula=$2', [session.data.correo, session.data.cedula]);
      if (result.rows.length) {
        const userRow = result.rows[0];
        session.estado = 'logueado';
        session.correo = session.data.correo;
        session.userRole = userRow.rol || 'student';

        if (session.roleIntent === 'admin') {
          if (!session.isAdminKeyVerified) {
            sessionStates.delete(waId);
            return t('bot_admin_must_verify');
          }
          if (session.userRole !== 'admin') {
            sessionStates.delete(waId);
            return t('bot_not_admin_account');
          }
        }

        return t('session_started');
      }
      sessionStates.delete(waId);
      return t('unrecognized');
    }
  }

  // 1.b) Registro de nuevo usuario
  if (session.estado === 'registro') {
    if (session.step === 1) {
      session.data.nombre = text;
      session.step = 2;
      return t('ask_id');
    }
    if (session.step === 2) {
      const cedulaInput = text;
      if (!isValidCedula(cedulaInput)) return t('error_invalid_cedula');
      session.data.cedula = cedulaInput;
      session.step = 3;
      return t('ask_email');
    }
    if (session.step === 3) {
      const emailInput = text;
      if (!isValidEmail(emailInput)) return t('error_invalid_email');
      session.data.correo = emailInput;

      const exists = await pool.query('SELECT * FROM usuario WHERE correo=$1', [session.data.correo]);
      if (exists.rowCount) {
        const row = exists.rows[0];
        session.estado = 'logueado';
        session.correo = session.data.correo;
        session.userRole = row.rol || 'student';
        return t('already_exist');
      }

      let rolToInsert = 'student';
      if (session.roleIntent === 'admin') {
        if (!session.isAdminKeyVerified) {
          sessionStates.delete(waId);
          return t('bot_admin_must_verify');
        }
        rolToInsert = 'admin';
      }

      try {
        await pool.query('INSERT INTO usuario(nombre, cedula, correo, rol) VALUES($1,$2,$3,$4)', [session.data.nombre, session.data.cedula, session.data.correo, rolToInsert]);
        session.estado = 'logueado';
        session.correo = session.data.correo;
        session.userRole = rolToInsert;
        return rolToInsert === 'admin' ? t('register_success_admin') : t('register_success_student');
      } catch (err) {
        console.error('Register insert error:', err);
        sessionStates.delete(waId);
        return t('register_fail');
      }
    }
  }

  // --- USUARIO YA LOGUEADO ---
  const correo = session.correo;
  const admin = (await isAdmin(correo)) || session.userRole === 'admin';

  // 2.a) Ayuda
  if (lower === t('opt_help')) {
    return admin ? t('help_admin') : t('help_student');
  }

  // 2.b) Comandos admin
  if (admin) {
    // Crear materia / create subject
    if (lower.startsWith(t('cmd_create_subject'))) {
      const fName = t('field_name');
      const fCode = t('field_code');
      const fSem  = t('field_semester');
      const fCred = t('field_credits');
      const fSeat = t('field_seats');
      const fDays = t('field_days');
      const fHrs  = t('field_hours');

      const reField = (field) => new RegExp(`${field}:\\s*([^\\n]+?)(?=\\s+\\w+:|$)`, 'i');

      const nombre   = text.match(reField(fName))?.[1]?.trim();
      const codigo   = text.match(reField(fCode))?.[1]?.trim();
      const semestre = text.match(new RegExp(`${fSem}:\\s*(\\d+)`, 'i'))?.[1];
      const creditos = text.match(new RegExp(`${fCred}:\\s*(\\d+)`, 'i'))?.[1];
      const cupos    = text.match(new RegExp(`${fSeat}:\\s*(\\d+)`, 'i'))?.[1];
      const dias     = text.match(reField(fDays))?.[1]?.trim();
      const horas    = text.match(reField(fHrs))?.[1]?.trim();

      if (!nombre || !codigo || !semestre || !creditos || !cupos || !dias || !horas) {
        return t('error_format_subject');
      }
      try {
        await pool.query(
          'INSERT INTO asignatura(nombre, codigo, semestre, creditos, cupos, dias, horas) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [nombre, codigo, parseInt(semestre, 10), parseInt(creditos, 10), parseInt(cupos, 10), dias, horas]
        );
        return t('subject_created', { nombre });
      } catch (e) {
        console.error('Error creating subject:', e);
        return t('error_subject_duplicate');
      }
    }

    // Crear carrera / create career
    if (lower.startsWith(t('cmd_create_career'))) {
      const fName = t('field_name');
      const fCode = t('field_code');
      const reField = (field) => new RegExp(`${field}:\\s*([^\\n]+?)(?=\\s+\\w+:|$)`, 'i');

      const nombre = text.match(reField(fName))?.[1]?.trim();
      const codigo = text.match(reField(fCode))?.[1]?.trim();

      if (!nombre || !codigo) {
        return t('error_format_career');
      }
      try {
        await pool.query('INSERT INTO carrera(nombre, codigo) VALUES($1,$2)', [nombre, codigo]);
        return t('career_created', { nombre });
      } catch (e) {
        console.error('Error creating career:', e);
        return t('error_career_duplicate');
      }
    }

    // Ver estudiantes (admin)
    if (lower === t('cmd_view_students') || lower === 'view students' || lower === '!view_students' || lower === '!ver_estudiantes') {
      try {
        const { rows } = await pool.query(`
          SELECT u.nombre, u.correo, u.cedula, c.nombre AS carrera
          FROM usuario u
          LEFT JOIN matricula m ON m.usuario_id = u.id
          LEFT JOIN matricula_carrera mc ON mc.matricula_id = m.id
          LEFT JOIN carrera c ON mc.carrera_id = c.id
          WHERE u.rol = 'student'
          ORDER BY u.nombre
        `);

        if (!rows.length) return t('admin_view_students_empty');

        let response = t('admin_view_students_title') + "\n\n";
        rows.forEach(s => {
          const item = t('admin_view_students_item')
            .replace('{name}', s.nombre || '-')
            .replace('{email}', s.correo || '-')
            .replace('{idNumber}', s.cedula || '-')
            .replace('{career}', s.carrera || (session.lng === 'es' ? 'No inscrito' : 'Not enrolled'));
          response += item + "\n";
        });

        return response;
      } catch (error) {
        console.error('Error getting students:', error);
        return t('error_general') || '❌ Error retrieving students.';
      }
    }

    return t('unrecognized');
  }

  // 2.c) Comandos estudiante
  if (!admin) {
    // Mis datos / my data (incluye carrera)
    if (lower === t('cmd_my_data') || lower === 'my data' || lower === 'mis datos') {
      try {
        const userRes = await pool.query('SELECT id, nombre, cedula, correo FROM usuario WHERE correo=$1 LIMIT 1', [correo]);
        if (!userRes.rows.length) return t('unrecognized');
        const u = userRes.rows[0];

        const career = await getCareerForUserByEmail(correo);
        const careerText = career ? career.nombre : (session.lng === 'es' ? 'No inscrito' : 'Not enrolled');

        return `🧾 ${t('cmd_my_data')}\n` +
               `Nombre: ${u.nombre}\n` +
               `Cédula: ${u.cedula}\n` +
               `Correo: ${u.correo}\n` +
               `${t('my_data_career')}: ${careerText}`;
      } catch (e) {
        console.error('Error mydata:', e);
        return t('unrecognized');
      }
    }

    // Ver materias / view subjects
    if (lower === t('cmd_view_subjects') || lower === 'view subjects' || lower === 'ver materias') {
      const { rows } = await pool.query('SELECT nombre, codigo, creditos FROM asignatura ORDER BY nombre');
      if (!rows.length) return t('no_subjects');
      return rows.map(a => `📘 ${a.nombre} (${a.codigo}) – ${a.creditos}cr`).join('\n');
    }

    // Inscribirme en / enroll in (materias)
    if (lower.startsWith('enroll in') || lower.startsWith(t('cmd_enroll').trim()) || lower.startsWith('inscribirme a') || lower.startsWith('inscribirme')) {
      // extraer código materia con regex robusta
      const match = text.match(/(?:enroll in|enroll|inscribirme a|inscribirme)\s*:?\s*([A-Za-z0-9_-]+)/i);
      const code = match?.[1]?.toUpperCase();
      if (!code) return t('unrecognized');

      const client = await pool.connect();
      try {
        // obtener usuario
        const userRes = await client.query('SELECT id FROM usuario WHERE correo=$1', [correo]);
        if (!userRes.rows.length) {
          client.release();
          return t('unrecognized');
        }
        const usuarioId = userRes.rows[0].id;
        const semestreActual = getCurrentSemester();

        // obtener o crear matricula
        let matRes = await client.query('SELECT id FROM matricula WHERE usuario_id=$1 AND semestre=$2', [usuarioId, semestreActual]);
        let matriculaId;
        if (!matRes.rows.length) {
          const ins = await client.query('INSERT INTO matricula(usuario_id, semestre, estado, total_creditos) VALUES($1,$2,$3,$4) RETURNING id', [usuarioId, semestreActual, 'activa', 0]);
          matriculaId = ins.rows[0].id;
        } else {
          matriculaId = matRes.rows[0].id;
        }

        // Lock asignatura row (evitar race)
        await client.query('BEGIN');
        const asigSel = await client.query('SELECT id, nombre, creditos, cupos, codigo FROM asignatura WHERE upper(codigo)=$1 FOR UPDATE', [code]);
        if (!asigSel.rows.length) {
          await client.query('ROLLBACK');
          client.release();
          return t('unrecognized');
        }
        const asig = asigSel.rows[0];
        if (asig.cupos <= 0) {
          await client.query('ROLLBACK');
          client.release();
          return t('no_seats');
        }

        // verificar si ya inscrito
        const ya = await client.query('SELECT 1 FROM matricula_asignatura WHERE matricula_id=$1 AND asignatura_id=$2', [matriculaId, asig.id]);
        if (ya.rowCount) {
          await client.query('ROLLBACK');
          client.release();
          return t('already_enrolled');
        }

        // insertar y actualizar dentro de tx
        await client.query('INSERT INTO matricula_asignatura(matricula_id, asignatura_id) VALUES($1,$2)', [matriculaId, asig.id]);
        await client.query('UPDATE matricula SET total_creditos = total_creditos + $1 WHERE id=$2', [asig.creditos, matriculaId]);
        await client.query('UPDATE asignatura SET cupos = cupos - 1 WHERE id=$1', [asig.id]);

        await client.query('COMMIT');
        client.release();
        return t('enroll_success', { nombre: asig.nombre, codigo: asig.codigo });
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
        client.release();
        console.error('Error enroll subject (tx):', err);
        return t('enroll_error');
      }
    }

    // Retirar materia / withdraw
    if (lower.startsWith(t('cmd_withdraw')) || lower.startsWith('withdraw') || lower.startsWith('retirar')) {
      const match = text.match(/(?:withdraw|retirar)\s*:?\s*([A-Za-z0-9_-]+)/i);
      const code = match?.[1]?.toUpperCase();
      if (!code) return t('unrecognized');

      try {
        const userRes = await pool.query('SELECT id FROM usuario WHERE correo=$1', [correo]);
        if (!userRes.rows.length) return t('unrecognized');
        const usuarioId = userRes.rows[0].id;
        const semestreActual = getCurrentSemester();

        const matRes = await pool.query('SELECT id FROM matricula WHERE usuario_id=$1 AND semestre=$2', [usuarioId, semestreActual]);
        if (!matRes.rows.length) return t('unrecognized');
        const matriculaId = matRes.rows[0].id;

        const asigRes = await pool.query('SELECT id, nombre, creditos, codigo FROM asignatura WHERE upper(codigo)=$1', [code]);
        if (!asigRes.rows.length) return t('unrecognized');
        const asig = asigRes.rows[0];

        const insRes = await pool.query('SELECT 1 FROM matricula_asignatura WHERE matricula_id=$1 AND asignatura_id=$2', [matriculaId, asig.id]);
        if (!insRes.rowCount) return t('not_enrolled');

        // transacción simple
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query('DELETE FROM matricula_asignatura WHERE matricula_id=$1 AND asignatura_id=$2', [matriculaId, asig.id]);
          await client.query('UPDATE matricula SET total_creditos = total_creditos - $1 WHERE id=$2', [asig.creditos, matriculaId]);
          await client.query('UPDATE asignatura SET cupos = cupos + 1 WHERE id=$1', [asig.id]);
          await client.query('COMMIT');
        } catch (err2) {
          await client.query('ROLLBACK');
          throw err2;
        } finally {
          client.release();
        }

        return t('withdraw_success', { nombre: asig.nombre });
      } catch (err) {
        console.error('Error withdraw subject:', err);
        return t('withdraw_error');
      }
    }

    // Inscribir en carrera (solo 1 vez) - transacción: matricula + matricula_carrera + set usuario.carrera_id si NULL
    if (
      lower.startsWith('inscribirme a') ||
      lower.startsWith('inscribir carrera') ||
      lower.startsWith('enroll career') ||
      lower.startsWith('enroll in career') ||
      lower.startsWith('enroll')
    ) {
      // extraer código
      const careerCode = (text.match(/(?:careercode|career|codigo|code):\s*([^\n\r]+)/i)?.[1] ||
                          text.match(/(?:inscribirme a|inscribir carrera|enroll in|enroll career|enroll)\s*:?\s*([A-Za-z0-9_-]+)/i)?.[1])?.trim().toUpperCase();

      if (!careerCode) return t('error_career_not_found');

      const client = await pool.connect();
      try {
        // obtener usuario
        const userRes = await client.query('SELECT id, carrera_id FROM usuario WHERE correo=$1 LIMIT 1', [correo]);
        if (!userRes.rows.length) {
          client.release();
          return t('unrecognized');
        }
        const usuarioId = userRes.rows[0].id;
        const usuarioCarreraId = userRes.rows[0].carrera_id || null;

        // si usuario ya tiene carrera (usuario.carrera_id) -> no permitir
        if (usuarioCarreraId) {
          client.release();
          return t('career_already_enrolled');
        }

        // verificar historial matricula_carrera (también bloquear)
        const hist = await client.query(`
          SELECT 1 FROM matricula_carrera mc
          JOIN matricula m ON mc.matricula_id = m.id
          WHERE m.usuario_id = $1
          LIMIT 1
        `, [usuarioId]);
        if (hist.rowCount) {
          client.release();
          return t('career_already_enrolled');
        }

        // buscar la carrera por codigo
        const careerRes = await client.query('SELECT id, nombre FROM carrera WHERE upper(codigo) = $1 LIMIT 1', [careerCode]);
        if (!careerRes.rows.length) {
          client.release();
          return t('error_career_not_found');
        }
        const carreraId = careerRes.rows[0].id;
        const careerName = careerRes.rows[0].nombre;

        // crear matricula si hace falta y asociar carrera, en tx
        await client.query('BEGIN');
        const semestreActual = getCurrentSemester();
        let matRes = await client.query('SELECT id FROM matricula WHERE usuario_id=$1 AND semestre=$2 LIMIT 1', [usuarioId, semestreActual]);
        let matriculaId;
        if (!matRes.rows.length) {
          const insMat = await client.query('INSERT INTO matricula (usuario_id, semestre, estado, total_creditos) VALUES ($1,$2,$3,$4) RETURNING id', [usuarioId, semestreActual, 'activa', 0]);
          matriculaId = insMat.rows[0].id;
        } else {
          matriculaId = matRes.rows[0].id;
        }

        // insertar en matricula_carrera
        await client.query('INSERT INTO matricula_carrera (matricula_id, carrera_id) VALUES ($1,$2)', [matriculaId, carreraId]);

        // intentar setear usuario.carrera_id solo si la columna existe y es null
        const hasCol = await usuarioHasCarreraIdColumn();
        if (hasCol) {
          await client.query('UPDATE usuario SET carrera_id = $1 WHERE id = $2 AND carrera_id IS NULL', [carreraId, usuarioId]);
        }

        await client.query('COMMIT');
        client.release();

        return t('career_enrolled_success', { careerName });
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
        client.release();
        console.error('Error enrolling career (tx):', err);
        return t('enroll_error');
      }
    }

    // Comando: pensum (genera PDF en memoria)
    const cmdPensum = t('cmd_pensum') || 'pensum';
    if (lower.startsWith(cmdPensum) || lower.startsWith('pensum')) {
      // Extraer código de carrera (si lo pasan)
      const fCode = t('field_code') || 'CareerCode';
      const careerCodeMatch =
        text.match(new RegExp(`${fCode}:\\s*([^\\n\\r]+)`, 'i')) ||
        text.match(/CareerCode:\s*([^\n\r]+)/i) ||
        text.match(/Codigo:\s*([^\n\r]+)/i) ||
        text.match(/Code:\s*([^\n\r]+)/i);

      const careerCode = careerCodeMatch?.[1]?.trim().toUpperCase();

      try {
        let careerId, careerName;

        if (careerCode) {
          const cRes = await pool.query('SELECT id, nombre, codigo FROM carrera WHERE upper(codigo) = $1', [careerCode]);
          if (!cRes.rows.length) return t('error_career_not_found');
          careerId = cRes.rows[0].id;
          careerName = cRes.rows[0].nombre;
        } else {
          const career = await getCareerForUserByEmail(correo);
          if (!career) return t('error_no_career_assigned');
          careerId = career.id;
          careerName = career.nombre;
        }

        // traer asignaturas del pensum
        const pensumRes = await pool.query(
          `SELECT codigo, nombre, semestre AS nivel, creditos, horas
           FROM asignatura
           WHERE carrera_id = $1
           ORDER BY semestre, nombre`,
          [careerId]
        );
        if (!pensumRes.rows.length) return t('no_subjects_for_career');

        // nombre estudiante
        const userNameRes = await pool.query('SELECT nombre FROM usuario WHERE correo = $1 LIMIT 1', [correo]);
        const studentName = userNameRes.rows[0]?.nombre || 'Student';

        // generar PDF en base64
        const pdfFile = await generatePensumPDFBase64(pensumRes.rows, careerName, studentName, session.lng);

        // Devolver objeto especial que la capa de WhatsApp debe interpretar para enviar archivo
        return {
          type: 'file',
          filename: pdfFile.filename,
          mime: pdfFile.mime,
          base64: pdfFile.base64,
          message: t('pensum_ready') || 'Pensum listo'
        };
      } catch (err) {
        console.error('Error generating pensum PDF', err);
        return t('pensum_error') || 'Error generating pensum';
      }
    }
  }

  return t('unrecognized');
}
