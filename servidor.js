'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { Pool, types } = require('pg');
types.setTypeParser(1082, value => value);

const BASE_DIR = __dirname;
const SQLITE_PATH = path.join(BASE_DIR, 'asistencia_inbefic.sqlite3');
const INDEX_FILE = 'Asistencia_INBEFIC_alumnos_funcionando (4).html';
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 8000);
const DATABASE_NAME = 'asistencia_inbefic_carlos';
const VALID_STATUSES = new Set(['ok', 'bad', 'warn']);
const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: DATABASE_NAME,
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD,
  connectionTimeoutMillis: 5000
});

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.ico', 'image/x-icon']
]);

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS app_state (
    id SMALLINT PRIMARY KEY CHECK (id = 1),
    active_week_start DATE NOT NULL,
    days_json JSONB NOT NULL
  );
  CREATE TABLE IF NOT EXISTS students (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    group_id TEXT,
    data_json JSONB NOT NULL
  );
  CREATE TABLE IF NOT EXISTS weeks (
    start_date DATE PRIMARY KEY,
    days_json JSONB NOT NULL
  );
  CREATE TABLE IF NOT EXISTS weekly_attendance (
    week_start DATE NOT NULL REFERENCES weeks(start_date) ON DELETE CASCADE,
    student_code TEXT NOT NULL,
    day_index INTEGER NOT NULL CHECK (day_index >= 0),
    status TEXT NOT NULL CHECK (status IN ('ok', 'bad', 'warn')),
    PRIMARY KEY (week_start, student_code, day_index)
  );
  CREATE TABLE IF NOT EXISTS daily_attendance (
    attendance_date DATE NOT NULL,
    student_code TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ok', 'bad', 'warn')),
    justification TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (attendance_date, student_code)
  );
  ALTER TABLE daily_attendance
    ADD COLUMN IF NOT EXISTS justification TEXT NOT NULL DEFAULT '';
`;

function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isValidStatus(status) {
  return typeof status === 'string' && VALID_STATUSES.has(status);
}

function dateToISO(value) {
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  throw new TypeError('PostgreSQL devolvió una fecha no válida.');
}

function validateState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new TypeError('El estado debe ser un objeto JSON.');
  }
  if (!isValidDate(state.activeWeekStart)) {
    throw new TypeError('La fecha de inicio de semana no es válida.');
  }
  if (!Array.isArray(state.students) || !Array.isArray(state.weeks)) {
    throw new TypeError('La lista de alumnos o semanas no es válida.');
  }
  if (!Array.isArray(state.days) || !state.days.every(day => typeof day === 'string')) {
    throw new TypeError('La lista de días no es válida.');
  }

  const dailyAttendance = state.dailyAttendance ?? {};
  const dailyJustifications = state.dailyJustifications ?? {};
  for (const [name, value] of Object.entries({ dailyAttendance, dailyJustifications })) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError(`El campo ${name} no es válido.`);
    }
  }

  const studentCodes = new Set();
  for (const student of state.students) {
    if (!student || typeof student !== 'object' || Array.isArray(student)) {
      throw new TypeError('Se encontró un alumno no válido.');
    }
    if (
      typeof student.code !== 'string' ||
      !student.code.trim() ||
      studentCodes.has(student.code) ||
      typeof student.name !== 'string' ||
      !Array.isArray(student.status) ||
      !student.status.every(isValidStatus)
    ) {
      throw new TypeError('Los datos o códigos de alumno no son válidos.');
    }
    studentCodes.add(student.code);
  }

  const weekStarts = new Set();
  for (const week of state.weeks) {
    if (!week || typeof week !== 'object' || !isValidDate(week.startDate)) {
      throw new TypeError('Se encontró una semana no válida.');
    }
    if (weekStarts.has(week.startDate)) {
      throw new TypeError('Las fechas de semana deben ser únicas.');
    }
    if (week.days !== undefined && (!Array.isArray(week.days) || !week.days.every(day => typeof day === 'string'))) {
      throw new TypeError('Los días de la semana no son válidos.');
    }
    const attendance = week.attendance ?? {};
    if (!attendance || typeof attendance !== 'object' || Array.isArray(attendance)) {
      throw new TypeError('La asistencia semanal no es válida.');
    }
    for (const statuses of Object.values(attendance)) {
      if (!Array.isArray(statuses) || !statuses.every(isValidStatus)) {
        throw new TypeError('Se encontró un estado de asistencia semanal no válido.');
      }
    }
    weekStarts.add(week.startDate);
  }

  for (const [attendanceDate, studentsForDay] of Object.entries(dailyAttendance)) {
    if (!isValidDate(attendanceDate) || !studentsForDay || typeof studentsForDay !== 'object' || Array.isArray(studentsForDay)) {
      throw new TypeError('Se encontró una fecha de asistencia diaria no válida.');
    }
    if (!Object.values(studentsForDay).every(isValidStatus)) {
      throw new TypeError('Se encontró un estado de asistencia diaria no válido.');
    }
  }

  for (const [attendanceDate, studentsForDay] of Object.entries(dailyJustifications)) {
    if (!isValidDate(attendanceDate) || !studentsForDay || typeof studentsForDay !== 'object' || Array.isArray(studentsForDay)) {
      throw new TypeError('Se encontró una fecha de justificación no válida.');
    }
    if (!Object.values(studentsForDay).every(value => typeof value === 'string' && value.length <= 2000)) {
      throw new TypeError('La justificación debe tener como máximo 2000 caracteres.');
    }
  }

  return {
    activeWeekStart: state.activeWeekStart,
    days: state.days,
    students: state.students,
    weeks: state.weeks,
    dailyAttendance,
    dailyJustifications
  };
}

function readLegacySqliteState() {
  if (!fs.existsSync(SQLITE_PATH)) return null;
  const legacyDb = new DatabaseSync(SQLITE_PATH);
  try {
    const appState = legacyDb.prepare(
      'SELECT active_week_start, days_json FROM app_state WHERE id = 1'
    ).get();
    if (!appState) return null;

    const students = legacyDb.prepare(
      'SELECT data_json FROM students ORDER BY rowid'
    ).all().map(row => JSON.parse(row.data_json));
    const weeks = legacyDb.prepare(
      'SELECT start_date, days_json FROM weeks ORDER BY start_date'
    ).all().map(row => ({
      startDate: row.start_date,
      days: JSON.parse(row.days_json),
      attendance: {}
    }));
    const weeksByStart = new Map(weeks.map(week => [week.startDate, week]));
    const weeklyRecords = legacyDb.prepare(`
      SELECT week_start, student_code, day_index, status
      FROM weekly_attendance
      ORDER BY week_start, student_code, day_index
    `).all();
    for (const record of weeklyRecords) {
      const attendance = weeksByStart.get(record.week_start).attendance;
      attendance[record.student_code] ??= [];
      while (attendance[record.student_code].length <= record.day_index) {
        attendance[record.student_code].push('warn');
      }
      attendance[record.student_code][record.day_index] = record.status;
    }

    const dailyAttendance = {};
    for (const record of legacyDb.prepare(
      'SELECT attendance_date, student_code, status FROM daily_attendance'
    ).all()) {
      dailyAttendance[record.attendance_date] ??= {};
      dailyAttendance[record.attendance_date][record.student_code] = record.status;
    }

    return {
      activeWeekStart: appState.active_week_start,
      days: JSON.parse(appState.days_json),
      students,
      weeks,
      dailyAttendance,
      dailyJustifications: {}
    };
  } finally {
    legacyDb.close();
  }
}

async function loadState(client = pool) {
  const appState = await client.query(
    'SELECT active_week_start, days_json FROM app_state WHERE id = 1'
  );
  if (!appState.rowCount) return null;

  const studentRows = await client.query('SELECT data_json FROM students ORDER BY code');
  const weekRows = await client.query('SELECT start_date, days_json FROM weeks ORDER BY start_date');
  const weeks = weekRows.rows.map(row => ({
    startDate: dateToISO(row.start_date),
    days: row.days_json,
    attendance: {}
  }));
  const weeksByStart = new Map(weeks.map(week => [week.startDate, week]));
  const weeklyRecords = await client.query(`
    SELECT week_start, student_code, day_index, status
    FROM weekly_attendance
    ORDER BY week_start, student_code, day_index
  `);
  for (const record of weeklyRecords.rows) {
    const weekStart = dateToISO(record.week_start);
    const attendance = weeksByStart.get(weekStart).attendance;
    attendance[record.student_code] ??= [];
    while (attendance[record.student_code].length <= record.day_index) {
      attendance[record.student_code].push('warn');
    }
    attendance[record.student_code][record.day_index] = record.status;
  }

  const dailyAttendance = {};
  const dailyJustifications = {};
  const dailyRows = await client.query(`
    SELECT attendance_date, student_code, status, justification
    FROM daily_attendance
  `);
  for (const record of dailyRows.rows) {
    const attendanceDate = dateToISO(record.attendance_date);
    dailyAttendance[attendanceDate] ??= {};
    dailyAttendance[attendanceDate][record.student_code] = record.status;
    if (record.justification) {
      dailyJustifications[attendanceDate] ??= {};
      dailyJustifications[attendanceDate][record.student_code] = record.justification;
    }
  }

  return {
    activeWeekStart: dateToISO(appState.rows[0].active_week_start),
    days: appState.rows[0].days_json,
    students: studentRows.rows.map(row => row.data_json),
    weeks,
    dailyAttendance,
    dailyJustifications
  };
}

async function insertRows(client, table, columns, rows) {
  const batchSize = 500;
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const parameters = [];
    const placeholders = batch.map((row, rowIndex) => {
      const values = row.map((value, columnIndex) => {
        parameters.push(value);
        const parameter = `$${rowIndex * columns.names.length + columnIndex + 1}`;
        return columnIndex === columns.jsonColumn ? `${parameter}::jsonb` : parameter;
      });
      return `(${values.join(', ')})`;
    });
    await client.query(
      `INSERT INTO ${table} (${columns.names.join(', ')}) VALUES ${placeholders.join(', ')}`,
      parameters
    );
  }
}

async function saveState(rawState) {
  const state = validateState(rawState);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      DELETE FROM daily_attendance;
      DELETE FROM weekly_attendance;
      DELETE FROM weeks;
      DELETE FROM students;
      DELETE FROM app_state;
    `);
    await client.query(
      'INSERT INTO app_state (id, active_week_start, days_json) VALUES (1, $1, $2::jsonb)',
      [state.activeWeekStart, JSON.stringify(state.days)]
    );
    await insertRows(client, 'students', {
      names: ['code', 'name', 'group_id', 'data_json'],
      jsonColumn: 3
    }, state.students.map(student => [
      student.code,
      student.name,
      student.groupId ?? null,
      JSON.stringify(student)
    ]));
    await insertRows(client, 'weeks', {
      names: ['start_date', 'days_json'],
      jsonColumn: 1
    }, state.weeks.map(week => [week.startDate, JSON.stringify(week.days ?? [])]));

    const weeklyRows = [];
    for (const week of state.weeks) {
      for (const [studentCode, statuses] of Object.entries(week.attendance ?? {})) {
        statuses.forEach((status, dayIndex) => {
          weeklyRows.push([week.startDate, studentCode, dayIndex, status]);
        });
      }
    }
    await insertRows(client, 'weekly_attendance', {
      names: ['week_start', 'student_code', 'day_index', 'status']
    }, weeklyRows);

    const dailyRows = [];
    for (const [attendanceDate, records] of Object.entries(state.dailyAttendance)) {
      for (const [studentCode, status] of Object.entries(records)) {
        dailyRows.push([
          attendanceDate,
          studentCode,
          status,
          state.dailyJustifications[attendanceDate]?.[studentCode] ?? ''
        ]);
      }
    }
    await insertRows(client, 'daily_attendance', {
      names: ['attendance_date', 'student_code', 'status', 'justification']
    }, dailyRows);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function sendJson(response, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  response.end(body);
}

function handleStaticFile(requestPath, response) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(requestPath);
  } catch {
    response.writeHead(400).end('Ruta no válida.');
    return;
  }
  const requestedPath = decodedPath === '/' ? INDEX_FILE : decodedPath.replace(/^\/+/, '');
  const filePath = path.resolve(BASE_DIR, requestedPath);
  if (!filePath.startsWith(BASE_DIR + path.sep) || path.basename(filePath) === path.basename(__filename)) {
    response.writeHead(404).end('Archivo no encontrado.');
    return;
  }
  const contentType = MIME_TYPES.get(path.extname(filePath).toLowerCase());
  if (!contentType) {
    response.writeHead(404).end('Archivo no encontrado.');
    return;
  }
  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) {
      response.writeHead(404).end('Archivo no encontrado.');
      return;
    }
    response.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stats.size,
      'Cache-Control': 'no-store'
    });
    fs.createReadStream(filePath).pipe(response);
  });
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    let oversized = false;
    request.setEncoding('utf8');
    request.on('data', chunk => {
      if (oversized) return;
      size += Buffer.byteLength(chunk, 'utf8');
      if (size > 5_000_000) {
        oversized = true;
        reject(Object.assign(new Error('El tamaño de la solicitud supera el límite permitido.'), { statusCode: 413 }));
        return;
      }
      body += chunk;
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

const server = http.createServer((request, response) => {
  void (async () => {
    const requestUrl = new URL(request.url, `http://${HOST}:${PORT}`);
    if (requestUrl.pathname === '/api/state' && request.method === 'GET') {
      sendJson(response, 200, { state: await loadState() });
      return;
    }
    if (requestUrl.pathname === '/api/state' && request.method === 'PUT') {
      const state = JSON.parse(await readRequestBody(request));
      await saveState(state);
      sendJson(response, 200, { saved: true });
      return;
    }
    if (request.method === 'GET') {
      handleStaticFile(requestUrl.pathname, response);
      return;
    }
    sendJson(response, 404, { error: 'Ruta no encontrada.' });
  })().catch(error => {
    if (response.writableEnded || response.destroyed) return;
    if (error instanceof SyntaxError || error instanceof TypeError || error.statusCode === 413) {
      sendJson(response, error.statusCode || 400, { error: error.message });
      return;
    }
    console.error('Error en la solicitud:', error);
    sendJson(response, 500, { error: 'Error al comunicarse con PostgreSQL. Revisa la conexión y la contraseña.' });
  });
});

server.on('error', error => {
  console.error('No se pudo iniciar el servidor local:', error.message);
  void pool.end().finally(() => {
    process.exitCode = 1;
  });
});

async function startServer() {
  let startupStep = 'crear tablas de PostgreSQL';
  console.log(`Conectando a PostgreSQL en localhost:5432/${DATABASE_NAME}...`);
  await pool.query(SCHEMA);
  startupStep = 'leer datos de PostgreSQL';
  let state = await loadState();
  if (!state) {
    startupStep = 'migrar los datos existentes de SQLite a PostgreSQL';
    const legacyState = readLegacySqliteState();
    if (legacyState) {
      await saveState(legacyState);
      state = legacyState;
      console.log(
        `Se migraron ${state.students.length} alumnos y ${Object.values(state.dailyAttendance).reduce((total, day) => total + Object.keys(day).length, 0)} registros de asistencia desde SQLite.`
      );
    }
  }
  startupStep = 'abrir el servidor web local';
  server.listen(PORT, HOST, () => {
    console.log(`Aplicación disponible en http://${HOST}:${PORT}/`);
    console.log(`PostgreSQL: localhost:5432/${DATABASE_NAME}`);
    if (process.env.ASISTENCIA_OPEN_BROWSER === '0') return;
    setTimeout(() => {
      const { execFile } = require('node:child_process');
      execFile('cmd', ['/c', 'start', '', `http://${HOST}:${PORT}/`], error => {
        if (error) console.warn('Abre manualmente la dirección local indicada arriba.');
      });
    }, 1000);
  });
}

startServer().catch(error => {
  console.error(`No se pudo completar el paso "${startupStep}" (${DATABASE_NAME}).`, error.message);
  if (error.code) console.error(`Código de error: ${error.code}`);
  console.error('Confirma que PostgreSQL esté activo, que la base exista y que la contraseña sea correcta.');
  process.exitCode = 1;
}).finally(() => {
  if (process.exitCode) void pool.end();
});

function closeServer() {
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on('SIGINT', closeServer);
process.on('SIGTERM', closeServer);
