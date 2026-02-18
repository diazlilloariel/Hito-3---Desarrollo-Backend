# Ferretex API (Backend) — Hito 3

API REST para **Ferretex**, enfocada en catálogo de productos, autenticación con JWT y flujo de órdenes con control de stock (on_hand / reserved).  
Este backend está diseñado para operar con roles y endpoints protegidos.

---

## Base URL (Dev)
- `http://localhost:3000`


---

## Autenticación (JWT)
Los endpoints protegidos requieren un token JWT en el header:

Authorization: Bearer <token>

**Cómo obtener el token:**
1. `POST /api/auth/login`
2. Guardar el `token` retornado
3. Enviar el token en los endpoints protegidos

---

## Roles y Acceso
Roles soportados:
- `customer`
- `staff`
- `manager`

Reglas de autorización (alto nivel):
- **Customer**: puede crear órdenes y ver *sus* órdenes.
- **Staff/Manager**: pueden listar, ver y actualizar el estado de órdenes (operaciones).
- **Manager**: rol administrativo (si tu front/backend agrega permisos extra, documentarlos aquí).

---

## Convenciones
- **Content-Type**: `application/json`
- Respuestas de error comunes:
  - `400` Bad Request (payload inválido / faltan campos)
  - `401` Unauthorized (token inválido o ausente)
  - `403` Forbidden (sin permisos por rol)
  - `404` Not Found (recurso inexistente)
  - `409` Conflict (conflicto de negocio, por ejemplo stock insuficiente)
  - `500` Internal Server Error

---

# Endpoints

## Health

### `GET /api/health`
**Descripción:** Healthcheck del API + ping a la base de datos.  
**Auth:** No

**200 OK**
```json
{ "ok": true, "db": "..." }
```

---

## Auth

### `POST /api/auth/register`
**Descripción:** Registro de usuario.  
**Auth:** No

**Body**
```json
{
  "name": "Nombre",
  "email": "correo@dominio.cl",
  "password": "password",
  "role": "customer|staff|manager"
}
```

**Notas:**
- `role` es opcional (default: `customer`).

**Respuestas:**
- `201 Created`: usuario creado (id, name, email, role)
- `400 Bad Request`: faltan campos o rol inválido
- `409 Conflict`: email ya registrado

---

### `POST /api/auth/login`
**Descripción:** Login y emisión de JWT.  
**Auth:** No

**Body**
```json
{
  "email": "correo@dominio.cl",
  "password": "password"
}
```

**Respuestas:**
- `200 OK`
```json
{
  "token": "JWT",
  "user": { "id": "...", "name": "...", "email": "...", "role": "customer" }
}
```
- `400 Bad Request`: faltan campos
- `401 Unauthorized`: credenciales inválidas

---

## Products

### `GET /api/products`
**Descripción:** Catálogo de productos **activos**, incluyendo stock disponible (`on_hand - reserved`).  
**Auth:** No

**Query Params**
- `q`: búsqueda por nombre (LIKE)
- `cat`: categoría (string). `all` para no filtrar
- `status`: estado de producto. `all` para no filtrar
- `sort`: `price_desc | name_asc | name_desc | price_asc` (default: `price_asc`)
- `inStock`: `true` para filtrar solo con stock disponible > 0
- `minPrice`: número
- `maxPrice`: número

**200 OK**
```json
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
```

---

### `GET /api/products/meta`
**Descripción:** Señal de cambios (`lastChanged`) para polling/refresh liviano.  
**Auth:** No

**200 OK**
```json
{ "lastChanged": "timestamp" }
```

---

### `GET /api/products/:id`
**Descripción:** Detalle de producto por id (**solo activos**).  
**Auth:** No

**Respuestas:**
- `200 OK`: producto
- `404 Not Found`: producto no encontrado

---

## Orders — Customer (Protegido)

### `POST /api/orders`
**Descripción:** Crea orden y **reserva stock** (`stock_reserved + qty`).  
**Auth:** Sí  
**Roles:** `customer`

**Body mínimo**
```json
{
  "items": [{ "productId": "ID_PRODUCTO", "qty": 1 }],
  "delivery_type": "pickup|delivery",
  "payment_method": "online|in_store",
  "notes": "opcional"
}
```

**Notas de negocio:**
- Acepta `delivery_type` y también `mode` (compatibilidad).
- Si `delivery_type = "delivery"`, puede usarse `address_id` (si aplica).
- Estado inicial: `pending_payment`.

**Respuestas:**
- `201 Created`
```json
{
  "message": "OK",
  "orderId": "...",
  "status": "pending_payment",
  "delivery_type": "pickup",
  "payment_method": "online",
  "total": 9990
}
```
- `400 Bad Request`: payload inválido / items inválidos / producto inexistente o inactivo
- `409 Conflict`: stock insuficiente (incluye `available` / `requested`)
- `500 Internal Server Error`: error creando orden

---

### `GET /api/orders/me`
**Descripción:** Lista órdenes del cliente autenticado.  
**Auth:** Sí  
**Roles:** `customer`

**200 OK:** arreglo de órdenes con totales y timestamps.

---

## Orders — Operaciones (Protegido)

### `GET /api/orders/meta`
**Descripción:** Señal de cambios (`lastChanged`) para órdenes (operaciones).  
**Auth:** Sí  
**Roles:** `staff`, `manager`

**200 OK**
```json
{ "lastChanged": "timestamp" }
```

---

### `GET /api/orders`
**Descripción:** Lista de órdenes (operaciones) con items agregados.  
**Auth:** Sí  
**Roles:** `staff`, `manager`

**Query Params**
- `status`: estado de la orden
- `deliveryType`: `pickup|delivery`
- `q`: búsqueda por id de orden o email del cliente
- `limit`: `1..200` (default `50`)
- `offset`: `0..N` (default `0`)

**200 OK:** arreglo de órdenes + customer + items.

---

### `GET /api/orders/:id`
**Descripción:** Obtiene una orden por id (operaciones) con items.  
**Auth:** Sí  
**Roles:** `staff`, `manager`

**Respuestas:**
- `200 OK`: orden
- `404 Not Found`: orden no encontrada

---

### `PATCH /api/orders/:id/status`
**Descripción:** Cambia el estado de una orden.  
**Auth:** Sí  
**Roles:** `staff`, `manager`

**Body**
```json
{
  "status": "pending_payment|paid|preparing|ready_for_pickup|shipped|delivered|cancelled"
}
```

**Reglas:**
- Si el status pasa a `cancelled` y antes no estaba cancelada, se **libera stock reservado**.

**Respuestas:**
- `200 OK`
```json
{ "orderId": "...", "status": "paid" }
```
- `400 Bad Request`: status inválido
- `404 Not Found`: orden no encontrada
- `500 Internal Server Error`: error interno

---

## 404 y Manejo de Errores

- Cualquier ruta no definida bajo `/api/*` devuelve:
  - `404`
```json
{ "message": "Ruta no encontrada" }
```

- Error handler central:
  - `500`
```json
{ "message": "Error interno" }
```

---

## License
Licensed under **CC BY-NC-ND 4.0** (Attribution required, non-commercial use only, no derivatives).  
https://creativecommons.org/licenses/by-nc-nd/4.0/
