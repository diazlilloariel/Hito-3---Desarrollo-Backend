# Ferretex Backend (Hito 3)

API REST para Ferretex (PostgreSQL + Express). Incluye autenticación JWT, catálogo de productos y flujo básico de órdenes.

## Requisitos
- Node.js 18+
- PostgreSQL 14+
- Base de datos creada y script ejecutado

## Variables de entorno
Crea un archivo `.env` en `backend/`:

```env
PORT=3000
DATABASE_URL=postgres://postgres:TU_PASSWORD@localhost:5432/ferretex
# opcional para tests si usas otra BD
# DATABASE_URL_TEST=postgres://postgres:TU_PASSWORD@localhost:5432/ferretex_test
JWT_SECRET=ferretex_secret_demo
