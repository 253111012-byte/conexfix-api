# Guía: poner ConexFix en línea (gratis, sin Firebase)

App Flutter → API (Node + Express, en Render) → MongoDB Atlas

## 1. Base de datos: MongoDB Atlas (gratis)
1. Crea cuenta en https://cloud.mongodb.com y elige **Build a Database → Free (M0)**.
2. **Database Access → Add New Database User**: crea usuario y contraseña (guárdalos).
3. **Network Access → Add IP Address → Allow access from anywhere (0.0.0.0/0)**.
   (Hace falta porque los servidores gratuitos cambian de IP.)
4. **Database → Connect → Drivers**: copia la cadena `mongodb+srv://...`.
   Reemplaza `<password>` por tu contraseña y agrega el nombre `conexfix` antes del `?`:
   `mongodb+srv://USUARIO:CONTRASENA@cluster0.xxxxx.mongodb.net/conexfix?retryWrites=true&w=majority`

## 2. Probar la API en tu PC (opcional)
```
cd conexfix-api
copy .env.example .env      (edita .env con tu cadena de MongoDB)
npm install
npm start
```
Abre http://localhost:3000 → debe mostrar `{"ok":true,"name":"ConexFix API"}`.

## 3. Subir la API a internet (Render)
1. Sube la carpeta `conexfix-api` a un repositorio de GitHub (sin `node_modules` ni `.env`).
2. En https://render.com → **New → Web Service** → conecta el repositorio.
3. Configura: Runtime **Node**, Build Command `npm install`, Start Command `npm start`, Instance Type **Free**.
4. En **Environment** agrega:
   - `MONGODB_URI` = tu cadena de Atlas
   - `JWT_SECRET` = un texto largo y aleatorio
   - `ADMIN_CODE` = `CONEXFIX-ADMIN-2026`
   - `ADMIN_REGISTER_CODE` = `CONEXFIX-ADMIN`
5. Deploy. Render te da una URL tipo `https://conexfix-api.onrender.com`.
   Ábrela: debe responder `{"ok":true,...}`.

Nota: el plan gratuito "duerme" tras ~15 min sin uso; la primera petición puede tardar hasta ~1 minuto.

### Alternativa: Vercel (si Render te pide tarjeta)
Importa el mismo repositorio en https://vercel.com (el archivo `vercel.json` ya está incluido)
y agrega las mismas variables de entorno.

## 4. Conectar la app
En `lib/config.dart` cambia `kApiBase` por tu URL (sin `/` final). Luego:
```
flutter clean
flutter pub get
flutter build apk --release
```
