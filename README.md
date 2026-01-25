# Ferretex API — Hito 3 (Backend)

Backend en **Node.js + Express** con **PostgreSQL**, autenticación **JWT**, control de acceso por **roles** y **tests** con **Jest + Supertest**.

---

## Stack
- Express, CORS, Morgan
- PostgreSQL (`pg`)
- JWT (`jsonwebtoken`)
- Hash de passwords (`bcryptjs`)
- Tests: `jest`, `supertest`

---

## Instalación
```bash
npm install

____________________________________________________________________________________

## Crea .env:

PORT=3000
DB_HOST=localhost
DB_USER=postgres
DB_PASSWORD=TU_PASSWORD
DB_NAME=ferretex
DB_PORT=5432
JWT_SECRET=TU_SECRET

____________________________________________________________________________________

## Ejecutar npm run dev

____________________________________________________________________________________

API: http://localhost:3000

____________________________________________________________________________________

Tests
npm test

____________________________________________________________________________________

Usuarios de prueba (opcional)

Crea por /api/auth/register:

manager@ferretex.cl / manager (role: manager)

staff@ferretex.cl / staff (role: staff)

client@ferretex.cl / client (role: customer)
