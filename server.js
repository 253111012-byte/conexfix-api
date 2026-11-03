require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

// ───────────── Configuración ─────────────
const MONGODB_URI = process.env.MONGODB_URI;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-cambiar';
const ADMIN_CODE = (process.env.ADMIN_CODE || 'CONEXFIX-ADMIN-2026').trim();
const ADMIN_REGISTER_CODE = (process.env.ADMIN_REGISTER_CODE || 'CONEXFIX-ADMIN').trim();
const DEFAULT_PLACES = [
  'Laboratorios de Redes',
  'Laboratorio 1',
  'Laboratorio 2',
  'Laboratorio 3',
  'Laboratorio 4',
];
const STATUS_COUNT = 3; // 0 Pendiente, 1 En revisión, 2 Resuelto

// ───────────── Modelos ─────────────
const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passHash: { type: String, required: true },
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  placeId: { type: String, default: null },
});
const placeSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
});
const reviewSchema = new mongoose.Schema(
  { stars: Number, comment: String, date: Date },
  { _id: false }
);
const reportSchema = new mongoose.Schema({
  num: { type: Number, unique: true, index: true },
  ownerEmail: String,
  ownerName: String,
  placeId: String,
  connection: String,
  problemType: String,
  description: String,
  dateTime: Date,
  evidence: { type: String, select: false, default: null }, // base64 (jpg/png)
  hasEvidence: { type: Boolean, default: false },
  status: { type: Number, default: 0 },
  staffComment: { type: String, default: '' },
  review: { type: reviewSchema, default: null },
  handledBy: { type: String, default: null },
  updatedAt: { type: Date, default: null },
});
const counterSchema = new mongoose.Schema({ _id: String, seq: { type: Number, default: 0 } });
const settingSchema = new mongoose.Schema({ _id: String, value: String });

const User = mongoose.model('User', userSchema);
const Place = mongoose.model('Place', placeSchema);
const Report = mongoose.model('Report', reportSchema);
const Counter = mongoose.model('Counter', counterSchema);
const Setting = mongoose.model('Setting', settingSchema);

// ───────────── Utilidades ─────────────
const userJson = (u) => ({
  name: u.name,
  email: u.email,
  role: u.role,
  placeId: u.placeId || null,
});
const reportJson = (r) => ({
  id: r.num,
  ownerEmail: r.ownerEmail,
  ownerName: r.ownerName,
  placeId: r.placeId,
  connection: r.connection,
  problemType: r.problemType,
  description: r.description,
  dateTime: r.dateTime.toISOString(),
  hasEvidence: !!r.hasEvidence,
  status: r.status,
  staffComment: r.staffComment || '',
  review: r.review
    ? { stars: r.review.stars, comment: r.review.comment, date: r.review.date.toISOString() }
    : null,
  handledBy: r.handledBy || null,
  updatedAt: r.updatedAt ? r.updatedAt.toISOString() : null,
});
const fail = (res, code, msg) => res.status(code).json({ error: msg });
const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error(e);
    fail(res, 500, 'Error interno del servidor.');
  });
const signToken = (u) => jwt.sign({ uid: u._id.toString() }, JWT_SECRET, { expiresIn: '60d' });
const emailRe = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function nextReportNum() {
  const c = await Counter.findByIdAndUpdate(
    'reports',
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return c.seq;
}
async function registerCode() {
  const s = await Setting.findById('adminCode');
  return s ? s.value : ADMIN_REGISTER_CODE;
}
async function validatePlaceName(name, exceptId) {
  const n = (name || '').trim();
  if (n.length < 2) return 'El nombre del lugar es muy corto.';
  if (n.length > 40) return 'El nombre del lugar es muy largo (máximo 40).';
  const dup = await Place.findOne({
    name: new RegExp('^' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i'),
  });
  if (dup && dup._id.toString() !== exceptId) return 'Ya existe un lugar con ese nombre.';
  return null;
}
async function seedPlaces() {
  if ((await Place.countDocuments()) === 0) {
    await Place.insertMany(DEFAULT_PLACES.map((name) => ({ name })));
  }
}

// ───────────── App ─────────────
const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '8mb' }));

// Conexión perezosa (sirve tanto para Render como para Vercel serverless)
let connecting = null;
async function ensureDb() {
  if (mongoose.connection.readyState === 1) return;
  if (!MONGODB_URI) throw new Error('Falta la variable MONGODB_URI');
  if (!connecting) {
    connecting = mongoose
      .connect(MONGODB_URI, { serverSelectionTimeoutMS: 15000 })
      .then(seedPlaces)
      .finally(() => (connecting = null));
  }
  await connecting;
}
app.use(async (req, res, next) => {
  if (req.path === '/' || req.path === '/health') return next();
  try {
    await ensureDb();
    next();
  } catch (e) {
    console.error('DB:', e.message);
    fail(res, 503, 'Base de datos no disponible. Intenta de nuevo en un momento.');
  }
});

app.get('/', (req, res) => res.json({ ok: true, name: 'ConexFix API' }));
app.get('/health', (req, res) =>
  res.json({ ok: true, db: mongoose.connection.readyState === 1 })
);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Espera unos minutos.' },
});
const codeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos con el código. Espera unos minutos.' },
});

// Autenticación: el rol se lee SIEMPRE de la base de datos
async function auth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return fail(res, 401, 'Sesión no válida.');
    const { uid } = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(uid);
    if (!user) return fail(res, 401, 'Sesión no válida.');
    req.user = user;
    next();
  } catch (e) {
    fail(res, 401, 'Sesión no válida.');
  }
}
const adminOnly = (req, res, next) =>
  req.user.role === 'admin' ? next() : fail(res, 403, 'Solo un administrador puede hacerlo.');

// ───────────── Auth ─────────────
app.post(
  '/auth/register',
  authLimiter,
  wrap(async (req, res) => {
    const { name, email, password, role, adminCode, placeId, newPlaceName } = req.body || {};
    const e = (email || '').trim().toLowerCase();
    if ((name || '').trim().length < 3) return fail(res, 400, 'El nombre debe tener mínimo 3 caracteres.');
    if (!emailRe.test(e)) return fail(res, 400, 'Correo no válido.');
    if (!password || String(password).length < 6) return fail(res, 400, 'La contraseña debe tener mínimo 6 caracteres.');
    if (await User.findOne({ email: e })) return fail(res, 409, 'Ya existe una cuenta con ese correo.');

    let finalRole = 'user';
    let pid = null;
    if (role === 'admin') {
      const code = (adminCode || '').trim();
      if (code !== (await registerCode()) && code !== ADMIN_CODE) {
        return fail(res, 403, 'Código de administrador incorrecto.');
      }
      finalRole = 'admin';
      const nn = (newPlaceName || '').trim();
      if (nn) {
        const err = await validatePlaceName(nn);
        if (err) return fail(res, 400, err);
        pid = (await Place.create({ name: nn }))._id.toString();
      } else {
        const ok = placeId && mongoose.isValidObjectId(placeId) && (await Place.findById(placeId));
        if (!ok) return fail(res, 400, 'Elige el lugar que vas a administrar.');
        pid = placeId;
      }
    }
    const user = await User.create({
      name: name.trim(),
      email: e,
      passHash: await bcrypt.hash(String(password), 10),
      role: finalRole,
      placeId: pid,
    });
    res.json({ token: signToken(user), user: userJson(user) });
  })
);

app.post(
  '/auth/login',
  authLimiter,
  wrap(async (req, res) => {
    const e = ((req.body || {}).email || '').trim().toLowerCase();
    const password = (req.body || {}).password || '';
    const user = await User.findOne({ email: e });
    if (!user) return fail(res, 404, 'No existe una cuenta con ese correo. Regístrate primero.');
    if (!(await bcrypt.compare(String(password), user.passHash))) return fail(res, 401, 'Contraseña incorrecta.');
    res.json({ token: signToken(user), user: userJson(user) });
  })
);

// ───────────── Perfil ─────────────
app.get('/me', auth, (req, res) => res.json({ user: userJson(req.user) }));

app.patch(
  '/me',
  auth,
  wrap(async (req, res) => {
    const name = ((req.body || {}).name || '').trim();
    if (name.length < 3) return fail(res, 400, 'Mínimo 3 caracteres.');
    req.user.name = name;
    await req.user.save();
    res.json({ user: userJson(req.user) });
  })
);

app.post(
  '/me/password',
  auth,
  wrap(async (req, res) => {
    const { current, next } = req.body || {};
    if (!(await bcrypt.compare(String(current || ''), req.user.passHash)))
      return fail(res, 400, 'La contraseña actual es incorrecta.');
    if (!next || String(next).length < 6) return fail(res, 400, 'Mínimo 6 caracteres.');
    req.user.passHash = await bcrypt.hash(String(next), 10);
    await req.user.save();
    res.json({ ok: true });
  })
);

// Código permanente: convierte la cuenta en Administrador
app.post(
  '/me/admin-code',
  auth,
  codeLimiter,
  wrap(async (req, res) => {
    if (req.user.role === 'admin') return fail(res, 400, 'Tu cuenta ya es de administrador.');
    const code = ((req.body || {}).code || '').trim();
    if (code !== ADMIN_CODE) return fail(res, 403, 'Código incorrecto. Verifica e inténtalo de nuevo.');
    req.user.role = 'admin';
    await req.user.save();
    res.json({ user: userJson(req.user) });
  })
);

app.put(
  '/me/place',
  auth,
  adminOnly,
  wrap(async (req, res) => {
    const id = (req.body || {}).placeId;
    if (!id || !mongoose.isValidObjectId(id) || !(await Place.findById(id)))
      return fail(res, 404, 'El lugar ya no existe.');
    req.user.placeId = id;
    await req.user.save();
    res.json({ user: userJson(req.user) });
  })
);

// Código usado al registrar nuevos administradores (editable por un admin)
app.get(
  '/settings/admin-code',
  auth,
  adminOnly,
  wrap(async (req, res) => res.json({ code: await registerCode() }))
);
app.put(
  '/settings/admin-code',
  auth,
  adminOnly,
  wrap(async (req, res) => {
    const c = ((req.body || {}).code || '').trim();
    if (c.length < 6) return fail(res, 400, 'El código debe tener al menos 6 caracteres.');
    await Setting.findByIdAndUpdate('adminCode', { value: c }, { upsert: true });
    res.json({ code: c });
  })
);

// ───────────── Lugares ─────────────
app.get(
  '/places',
  wrap(async (req, res) => {
    const [places, rep, pend, adm] = await Promise.all([
      Place.find().sort({ _id: 1 }),
      Report.aggregate([{ $group: { _id: '$placeId', n: { $sum: 1 } } }]),
      Report.aggregate([{ $match: { status: { $ne: 2 } } }, { $group: { _id: '$placeId', n: { $sum: 1 } } }]),
      User.aggregate([{ $match: { role: 'admin' } }, { $group: { _id: '$placeId', n: { $sum: 1 } } }]),
    ]);
    const m = (arr) => Object.fromEntries(arr.map((x) => [x._id, x.n]));
    const R = m(rep), P = m(pend), A = m(adm);
    res.json({
      places: places.map((p) => ({
        id: p._id.toString(),
        name: p.name,
        reportCount: R[p._id.toString()] || 0,
        pendingCount: P[p._id.toString()] || 0,
        adminCount: A[p._id.toString()] || 0,
      })),
    });
  })
);

app.post(
  '/places',
  auth,
  adminOnly,
  wrap(async (req, res) => {
    const name = ((req.body || {}).name || '').trim();
    const err = await validatePlaceName(name);
    if (err) return fail(res, 400, err);
    const p = await Place.create({ name });
    res.json({ id: p._id.toString(), name: p.name });
  })
);

app.patch(
  '/places/:id',
  auth,
  adminOnly,
  wrap(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return fail(res, 404, 'El lugar ya no existe.');
    const p = await Place.findById(req.params.id);
    if (!p) return fail(res, 404, 'El lugar ya no existe.');
    const name = ((req.body || {}).name || '').trim();
    const err = await validatePlaceName(name, p._id.toString());
    if (err) return fail(res, 400, err);
    p.name = name;
    await p.save();
    res.json({ id: p._id.toString(), name: p.name });
  })
);

app.delete(
  '/places/:id',
  auth,
  adminOnly,
  wrap(async (req, res) => {
    const id = req.params.id;
    if (!mongoose.isValidObjectId(id)) return fail(res, 404, 'El lugar ya no existe.');
    if ((await Place.countDocuments()) <= 1) return fail(res, 400, 'Debe existir al menos un lugar.');
    if ((await Report.countDocuments({ placeId: id })) > 0)
      return fail(res, 400, 'No se puede eliminar: tiene reportes registrados.');
    if ((await User.countDocuments({ role: 'admin', placeId: id })) > 0)
      return fail(res, 400, 'No se puede eliminar: hay administradores asignados a este lugar.');
    await Place.findByIdAndDelete(id);
    res.json({ ok: true });
  })
);

// ───────────── Reportes ─────────────
app.get(
  '/reports',
  auth,
  wrap(async (req, res) => {
    const q = req.user.role === 'admin' ? {} : { ownerEmail: req.user.email };
    const list = await Report.find(q).sort({ num: -1 }); // evidence no se incluye
    res.json({ reports: list.map(reportJson) });
  })
);

app.post(
  '/reports',
  auth,
  wrap(async (req, res) => {
    if (req.user.role === 'admin') return fail(res, 403, 'Los administradores no envían reportes.');
    const b = req.body || {};
    if (!b.placeId || !mongoose.isValidObjectId(b.placeId) || !(await Place.findById(b.placeId)))
      return fail(res, 400, 'Elige un lugar válido.');
    const dt = new Date(b.dateTime);
    if (isNaN(dt.getTime())) return fail(res, 400, 'Fecha no válida.');
    if (dt.getTime() > Date.now() + 5 * 60 * 1000) return fail(res, 400, 'La fecha no puede estar en el futuro.');
    for (const k of ['connection', 'problemType', 'description'])
      if (!String(b[k] || '').trim()) return fail(res, 400, 'Faltan datos del reporte.');
    let evidence = null;
    if (b.evidence) {
      evidence = String(b.evidence);
      if (evidence.length > 6 * 1024 * 1024) return fail(res, 413, 'La imagen es demasiado grande.');
    }
    const r = await Report.create({
      num: await nextReportNum(),
      ownerEmail: req.user.email,
      ownerName: req.user.name,
      placeId: b.placeId,
      connection: String(b.connection).trim(),
      problemType: String(b.problemType).trim(),
      description: String(b.description).trim(),
      dateTime: dt,
      evidence,
      hasEvidence: !!evidence,
    });
    res.json({ report: reportJson(r) });
  })
);

async function findReport(req, res) {
  const num = parseInt(req.params.id, 10);
  const r = Number.isNaN(num) ? null : await Report.findOne({ num });
  if (!r) {
    fail(res, 404, 'El reporte no existe.');
    return null;
  }
  return r;
}

// El administrador cambia el estado y/o deja un comentario para el usuario
app.patch(
  '/reports/:id',
  auth,
  adminOnly,
  wrap(async (req, res) => {
    const r = await findReport(req, res);
    if (!r) return;
    const { status, staffComment } = req.body || {};
    if (status !== undefined) {
      if (!Number.isInteger(status) || status < 0 || status >= STATUS_COUNT)
        return fail(res, 400, 'Estado no válido.');
      r.status = status;
    }
    if (staffComment !== undefined) r.staffComment = String(staffComment).trim().slice(0, 500);
    r.handledBy = req.user.name;
    r.updatedAt = new Date();
    await r.save();
    res.json({ report: reportJson(r) });
  })
);

app.post(
  '/reports/:id/review',
  auth,
  wrap(async (req, res) => {
    const r = await findReport(req, res);
    if (!r) return;
    if (req.user.role === 'admin' || r.ownerEmail !== req.user.email)
      return fail(res, 403, 'Solo quien envió el reporte puede reseñarlo.');
    if (r.status !== 2) return fail(res, 400, 'Solo puedes reseñar reportes resueltos.');
    if (r.review) return fail(res, 400, 'Este reporte ya tiene una reseña.');
    const stars = parseInt((req.body || {}).stars, 10);
    if (!(stars >= 1 && stars <= 5)) return fail(res, 400, 'Elige de 1 a 5 estrellas.');
    r.review = { stars, comment: String((req.body || {}).comment || '').trim().slice(0, 500), date: new Date() };
    await r.save();
    res.json({ report: reportJson(r) });
  })
);

app.get(
  '/reports/:id/evidence',
  auth,
  wrap(async (req, res) => {
    const num = parseInt(req.params.id, 10);
    const r = Number.isNaN(num) ? null : await Report.findOne({ num }).select('+evidence ownerEmail');
    if (!r) return fail(res, 404, 'El reporte no existe.');
    if (req.user.role !== 'admin' && r.ownerEmail !== req.user.email)
      return fail(res, 403, 'Sin permiso.');
    if (!r.evidence) return fail(res, 404, 'Sin evidencia.');
    res.json({ data: r.evidence });
  })
);

app.use((req, res) => fail(res, 404, 'Ruta no encontrada.'));

// ───────────── Arranque ─────────────
if (process.env.VERCEL) {
  module.exports = app; // Vercel serverless
} else {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`ConexFix API escuchando en el puerto ${port}`));
  module.exports = app;
}
