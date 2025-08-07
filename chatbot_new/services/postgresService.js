import { pool } from '../config/db.js';
import i18next from '../config/i18n.js';

async function isAdmin(correo) {
  const { rows } = await pool.query('SELECT COUNT(*) AS total FROM usuario');
  const total = parseInt(rows[0].total, 10);
  if (total === 1) {
    const { rows: adminRows } = await pool.query('SELECT correo FROM usuario LIMIT 1');
    return adminRows[0].correo === correo;
  }
  return false;
}

const sessionStates = new Map();

export async function handleAcademicMessage(waId, text) {
  // Inicializar o recuperar sesión
  let session = sessionStates.get(waId);
  if (!session) {
    session = { estado: null, step: 0, data: {}, lng: 'es' };
    sessionStates.set(waId, session);
  }

  // Helper de traducción
  const t = (key, opts) => i18next.t(key, { lng: session.lng, ...opts });
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

  // 1) Flujo de registro / login
  if (!session.estado) {
    if (lower === t('opt_registered')) {
      session.estado = 'verificando';
      session.step = 1;
      return t('ask_email');
    }
    if (lower === t('opt_register')) {
      session.estado = 'registro';
      session.step = 1;
      return t('ask_name');
    }
    return `${t('welcome')}\n- ${t('opt_registered')}\n- ${t('opt_register')}`;
  }

  // 1.a) Verificación de usuario existente
  if (session.estado === 'verificando') {
    if (session.step === 1) {
      session.data.correo = text.trim();
      session.step = 2;
      return t('ask_id');
    }
    if (session.step === 2) {
      session.data.cedula = text.trim();
      const result = await pool.query(
        'SELECT * FROM usuario WHERE correo=$1 AND cedula=$2',
        [session.data.correo, session.data.cedula]
      );
      if (result.rows.length) {
        session.estado = 'logueado';
        session.correo = session.data.correo;
        return t('session_started');
      }
      sessionStates.delete(waId);
      return t('unrecognized');
    }
  }

  // 1.b) Registro de nuevo usuario
  if (session.estado === 'registro') {
    if (session.step === 1) {
      session.data.nombre = text.trim();
      session.step = 2;
      return t('ask_id');
    }
    if (session.step === 2) {
      session.data.cedula = text.trim();
      session.step = 3;
      return t('ask_email');
    }
    if (session.step === 3) {
      session.data.correo = text.trim();
      const exists = await pool.query(
        'SELECT 1 FROM usuario WHERE correo=$1',
        [session.data.correo]
      );
      if (exists.rowCount) {
        session.estado = 'logueado';
        session.correo = session.data.correo;
        return t('already_exist');
      }
      try {
        await pool.query(
          'INSERT INTO usuario(nombre, cedula, correo) VALUES($1,$2,$3)',
          [session.data.nombre, session.data.cedula, session.data.correo]
        );
        session.estado = 'logueado';
        session.correo = session.data.correo;
        const admin = await isAdmin(session.correo);
        return admin
          ? t('register_success_admin')
          : t('register_success_student');
      } catch {
        sessionStates.delete(waId);
        return t('register_fail');
      }
    }
  }

  // 2) Usuario ya logueado
  const correo = session.correo;
  const admin = await isAdmin(correo);

  // 2.a) Ayuda
  if (lower === t('opt_help')) {
    return admin ? t('help_admin') : t('help_student');
  }

  // 2.b) Comandos admin
  if (admin) {
    // Crear materia / create subject
    if (lower.startsWith(t('cmd_create_subject'))) {
      // Campos dinámicos según idioma
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
          [
            nombre,
            codigo,
            parseInt(semestre, 10),
            parseInt(creditos, 10),
            parseInt(cupos, 10),
            dias,
            horas
          ]
        );
        return t('subject_created', { nombre });
      } catch {
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
        await pool.query(
          'INSERT INTO carrera(nombre, codigo) VALUES($1,$2)',
          [nombre, codigo]
        );
        return t('career_created', { nombre });
      } catch {
        return t('error_career_duplicate');
      }
    }

    return t('unrecognized');
  }

  // 2.c) Comandos estudiante
  if (!admin) {
    // Mis datos / my data
    if (lower === t('cmd_my_data')) {
      const { rows } = await pool.query(
        'SELECT nombre, cedula, correo FROM usuario WHERE correo=$1',
        [correo]
      );
      const u = rows[0];
      return `🧾 Nombre: ${u.nombre}\nCédula: ${u.cedula}\nCorreo: ${u.correo}`;
    }

    // Ver materias / view subjects
    if (lower === t('cmd_view_subjects')) {
      const { rows } = await pool.query(
        'SELECT nombre, codigo, creditos FROM asignatura'
      );
      if (!rows.length) return t('no_subjects');
      return rows.map(a => `📘 ${a.nombre} (${a.codigo}) – ${a.creditos}cr`).join('\n');
    }

    // Inscribirme en / enroll in
    if (lower.startsWith(t('cmd_enroll'))) {
      const code = text.slice(t('cmd_enroll').length).trim().toUpperCase();
      try {
        const userRes = await pool.query(
          'SELECT id FROM usuario WHERE correo=$1',
          [correo]
        );
        if (!userRes.rows.length) return t('unrecognized');
        const usuarioId = userRes.rows[0].id;
        const semestreActual = '2025-2';

        let matRes = await pool.query(
          'SELECT id FROM matricula WHERE usuario_id=$1 AND semestre=$2',
          [usuarioId, semestreActual]
        );
        let matriculaId;
        if (!matRes.rows.length) {
          const ins = await pool.query(
            'INSERT INTO matricula(usuario_id, semestre, estado, total_creditos) VALUES($1,$2,$3,$4) RETURNING id',
            [usuarioId, semestreActual, 'activa', 0]
          );
          matriculaId = ins.rows[0].id;
        } else {
          matriculaId = matRes.rows[0].id;
        }

        const asigRes = await pool.query(
          'SELECT id, nombre, creditos, cupos, codigo FROM asignatura WHERE codigo=$1',
          [code]
        );
        if (!asigRes.rows.length) return t('unrecognized');
        const asig = asigRes.rows[0];
        if (asig.cupos <= 0) return t('no_seats');

        const ya = await pool.query(
          'SELECT 1 FROM matricula_asignatura WHERE matricula_id=$1 AND asignatura_id=$2',
          [matriculaId, asig.id]
        );
        if (ya.rowCount) return t('already_enrolled');

        await pool.query(
          'INSERT INTO matricula_asignatura(matricula_id, asignatura_id) VALUES($1,$2)',
          [matriculaId, asig.id]
        );
        await pool.query(
          'UPDATE matricula SET total_creditos = total_creditos + $1 WHERE id=$2',
          [asig.creditos, matriculaId]
        );
        await pool.query(
          'UPDATE asignatura SET cupos = cupos - 1 WHERE id=$1',
          [asig.id]
        );

        return t('enroll_success', { nombre: asig.nombre, codigo: asig.codigo });
      } catch {
        return t('enroll_error');
      }
    }

    // Retirar materia / withdraw
    if (lower.startsWith(t('cmd_withdraw'))) {
      const code = text.slice(t('cmd_withdraw').length).trim().toUpperCase();
      try {
        const userRes = await pool.query(
          'SELECT id FROM usuario WHERE correo=$1',
          [correo]
        );
        if (!userRes.rows.length) return t('unrecognized');
        const usuarioId = userRes.rows[0].id;
        const semestreActual = '2025-2';

        const matRes = await pool.query(
          'SELECT id FROM matricula WHERE usuario_id=$1 AND semestre=$2',
          [usuarioId, semestreActual]
        );
        if (!matRes.rows.length) return t('unrecognized');
        const matriculaId = matRes.rows[0].id;

        const asigRes = await pool.query(
          'SELECT id, nombre, creditos, codigo FROM asignatura WHERE codigo=$1',
          [code]
        );
        if (!asigRes.rows.length) return t('unrecognized');
        const asig = asigRes.rows[0];

        const insRes = await pool.query(
          'SELECT 1 FROM matricula_asignatura WHERE matricula_id=$1 AND asignatura_id=$2',
          [matriculaId, asig.id]
        );
        if (!insRes.rowCount) return t('not_enrolled');

        await pool.query(
          'DELETE FROM matricula_asignatura WHERE matricula_id=$1 AND asignatura_id=$2',
          [matriculaId, asig.id]
        );
        await pool.query(
          'UPDATE matricula SET total_creditos = total_creditos - $1 WHERE id=$2',
          [asig.creditos, matriculaId]
        );
        await pool.query(
          'UPDATE asignatura SET cupos = cupos + 1 WHERE id=$1',
          [asig.id]
        );

        return t('withdraw_success', { nombre: asig.nombre });
      } catch {
        return t('withdraw_error');
      }
    }
  }

  return t('unrecognized');
}
