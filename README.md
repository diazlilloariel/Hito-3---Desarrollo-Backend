FERRETEX API (BACKEND) — HITO 3
Endpoints y Acceso

Base URL (dev)
- http://localhost:3000

Autenticación
- Los endpoints protegidos requieren JWT en el header:
  Authorization: Bearer <token>

Roles soportados
- customer
- staff
- manager

============================================================
HEALTH
============================================================
GET /api/health
- Descripción: Healthcheck del API + ping a la base de datos.
- Auth: No
- Respuesta: { ok: true, db: ... }

============================================================
AUTH
============================================================
POST /api/auth/register
- Descripción: Registro de usuario.
- Auth: No
- Body (JSON):
  {
    "name": "Nombre",
    "email": "correo@dominio.cl",
    "password": "password",
    "role": "customer|staff|manager"   (opcional, default: customer)
  }
- Respuestas:
  - 201: usuario creado (id, name, email, role)
  - 400: faltan campos o rol inválido
  - 409: email ya registrado

POST /api/auth/login
- Descripción: Login y emisión de JWT.
- Auth: No
- Body (JSON):
  {
    "email": "correo@dominio.cl",
    "password": "password"
  }
- Respuestas:
  - 200: { token, user: { id, name, email, role } }
  - 400: faltan campos
  - 401: credenciales inválidas

============================================================
PRODUCTS
============================================================
GET /api/products
- Descripción: Catálogo de productos (activos) con stock disponible (on_hand - reserved).
- Auth: No
- Query params soportados:
  - q: búsqueda por nombre (LIKE)
  - cat: categoría (string). "all" para no filtrar
  - status: estado de producto. "all" para no filtrar
  - sort: price_desc | name_asc | name_desc | (default: price_asc)
  - inStock: true para filtrar solo con stock disponible > 0
  - minPrice: número
  - maxPrice: número
- Respuesta: arreglo de productos
  [
    {
      "id": "...",
      "sku": "...",
      "name": "...",
      "description": "...",
      "price": 12345,
      "image": "...",
      "status": "...",
      "category": "...",
      "stock": 10
    }
  ]

GET /api/products/meta
- Descripción: Señal de cambios (lastChanged) para polling/refresh liviano.
- Auth: No
- Respuesta:
  { "lastChanged": "timestamp" }

GET /api/products/:id
- Descripción: Detalle de un producto por id (solo activos).
- Auth: No
- Respuestas:
  - 200: producto
  - 404: producto no encontrado

============================================================
ORDERS — CUSTOMER (PROTEGIDO)
============================================================
POST /api/orders
- Descripción: Crea orden y RESERVA stock (stock_reserved + qty).
- Auth: Sí
- Roles: customer
- Body (JSON) mínimo:
  {
    "items": [
      { "productId": "ID_PRODUCTO", "qty": 1 }
    ],
    "delivery_type": "pickup|delivery",     (acepta también "mode")
    "payment_method": "online|in_store",    (default: online)
    "notes": "opcional"
  }
- Notas:
  - Si delivery_type = delivery, puede usar address_id.
  - El status inicial queda: pending_payment
- Respuestas:
  - 201: { message, orderId, status, delivery_type, payment_method, total, phone?, address? }
  - 400: payload inválido / items inválidos / producto inexistente o inactivo
  - 409: stock insuficiente (incluye available/requested)
  - 500: error creando orden

GET /api/orders/me
- Descripción: Lista órdenes del cliente autenticado.
- Auth: Sí
- Roles: customer
- Respuesta: arreglo de órdenes con totales y timestamps.

============================================================
ORDERS — OPS (PROTEGIDO)
============================================================
GET /api/orders/meta
- Descripción: Señal de cambios (lastChanged) para órdenes (operaciones).
- Auth: Sí
- Roles: staff, manager
- Respuesta:
  { "lastChanged": "timestamp" }

GET /api/orders
- Descripción: Lista de órdenes (operaciones) con items agregados.
- Auth: Sí
- Roles: staff, manager
- Query params soportados:
  - status: estado de la orden
  - deliveryType: pickup|delivery
  - q: búsqueda por id de orden o email del cliente
  - limit: 1..200 (default 50)
  - offset: 0..N (default 0)
- Respuesta: arreglo de órdenes + customer + items.

GET /api/orders/:id
- Descripción: Obtiene una orden por id (operaciones) con items.
- Auth: Sí
- Roles: staff, manager
- Respuestas:
  - 200: orden
  - 404: orden no encontrada

PATCH /api/orders/:id/status
- Descripción: Cambia estado de una orden.
- Auth: Sí
- Roles: staff, manager
- Body (JSON):
  { "status": "pending_payment|paid|preparing|ready_for_pickup|shipped|delivered|cancelled" }
- Reglas:
  - Si status pasa a "cancelled" y antes no estaba cancelada, libera stock reservado.
- Respuestas:
  - 200: { orderId, status }
  - 400: status inválido
  - 404: orden no encontrada
  - 500: error interno

============================================================
ERRORS / 404
============================================================
- Cualquier ruta no definida bajo /api/* devuelve:
  404 { "message": "Ruta no encontrada" }
- Error handler central:
  500 { "message": "Error interno" }
