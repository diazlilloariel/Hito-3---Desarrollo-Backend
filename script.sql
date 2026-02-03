BEGIN;

-- =========================================================
--  Ferretex - Schema profesional (PostgreSQL)
--  Incluye:
--   - users, categories, products, inventory
--   - addresses, orders, order_items, payments, stock_movements
--   - constraints, indexes, triggers updated_at
--   - seed básico (categories + products + inventory)
-- =========================================================

-- Extensiones útiles
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------
-- Limpieza (si re-ejecutas)
-- ---------------------------------------------------------
DROP TABLE IF EXISTS stock_movements CASCADE;
DROP TABLE IF EXISTS payments CASCADE;
DROP TABLE IF EXISTS order_items CASCADE;
DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS addresses CASCADE;
DROP TABLE IF EXISTS inventory CASCADE;
DROP TABLE IF EXISTS products CASCADE;
DROP TABLE IF EXISTS categories CASCADE;
DROP TABLE IF EXISTS users CASCADE;

-- ---------------------------------------------------------
-- Función genérica updated_at
-- ---------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =========================================================
-- USERS
-- =========================================================
CREATE TABLE users (
  id             BIGSERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  email          CITEXT NOT NULL UNIQUE,
  phone          TEXT,
  password_hash  TEXT NOT NULL,

  -- Roles normalizados (alineados con backend/frontend)
  role           TEXT NOT NULL CHECK (role IN ('customer','staff','manager')),

  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_role ON users(role);

-- =========================================================
-- CATEGORIES
-- =========================================================
CREATE TABLE categories (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_categories_updated
BEFORE UPDATE ON categories
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =========================================================
-- PRODUCTS
-- =========================================================
CREATE TABLE products (
  id          TEXT PRIMARY KEY,               -- ejemplo: p1, p2, ...
  sku         TEXT UNIQUE,
  name        TEXT NOT NULL,
  description TEXT,
  price       INTEGER NOT NULL CHECK (price >= 0),     -- CLP entero
  image_url   TEXT,
  category_id BIGINT NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,

  -- status para UX (etiquetas "offer/new")
  status      TEXT NOT NULL DEFAULT 'none' CHECK (status IN ('none','offer','new')),
  active      BOOLEAN NOT NULL DEFAULT TRUE,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_products_category_id ON products(category_id);
CREATE INDEX idx_products_active ON products(active);
CREATE INDEX idx_products_status ON products(status);

CREATE TRIGGER trg_products_updated
BEFORE UPDATE ON products
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =========================================================
-- INVENTORY (1-1 con products)
-- =========================================================
CREATE TABLE inventory (
  product_id      TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  stock_on_hand   INTEGER NOT NULL CHECK (stock_on_hand >= 0),
  stock_reserved  INTEGER NOT NULL DEFAULT 0 CHECK (stock_reserved >= 0),
  stock_min       INTEGER NOT NULL DEFAULT 0 CHECK (stock_min >= 0),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_inventory_reserved_le_on_hand CHECK (stock_reserved <= stock_on_hand)
);

CREATE INDEX idx_inventory_stock_on_hand ON inventory(stock_on_hand);

CREATE TRIGGER trg_inventory_updated
BEFORE UPDATE ON inventory
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =========================================================
-- ADDRESSES (1-N con users)
-- =========================================================
CREATE TABLE addresses (
  id               BIGSERIAL PRIMARY KEY,
  user_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label            TEXT, -- "Casa", "Oficina"
  line1            TEXT NOT NULL,
  line2            TEXT,
  comuna           TEXT NOT NULL,
  ciudad           TEXT NOT NULL,
  referencia       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_addresses_user_id ON addresses(user_id);

CREATE TRIGGER trg_addresses_updated
BEFORE UPDATE ON addresses
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =========================================================
-- ORDERS
-- =========================================================
CREATE TABLE orders (
  id            TEXT PRIMARY KEY, -- ejemplo: FX-123456 (lo genera backend)
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  -- entrega y pago normalizados
  delivery_type TEXT NOT NULL CHECK (delivery_type IN ('pickup','delivery')),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('online','in_store')),

  -- estado operacional profesional (minúsculas y explícito)
  status        TEXT NOT NULL DEFAULT 'pending_payment'
                CHECK (status IN (
                  'pending_payment',
                  'paid',
                  'preparing',
                  'ready_for_pickup',
                  'shipped',
                  'delivered',
                  'cancelled'
                )),

  address_id    BIGINT NULL REFERENCES addresses(id) ON DELETE SET NULL,

  subtotal      INTEGER NOT NULL CHECK (subtotal >= 0),
  shipping_cost INTEGER NOT NULL DEFAULT 0 CHECK (shipping_cost >= 0),
  total         INTEGER NOT NULL CHECK (total >= 0),

  -- ✅ CLAVE: usado por auto-cancel y por createOrder (payment online)
  expires_at    TIMESTAMPTZ NULL,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_orders_user_id_created_at ON orders(user_id, created_at DESC);
CREATE INDEX idx_orders_status ON orders(status);

-- ✅ Recomendado: acelera el job de auto-cancel (solo mira pending_payment + online)
CREATE INDEX idx_orders_pending_online_expires
ON orders(expires_at)
WHERE status = 'pending_payment' AND payment_method = 'online' AND expires_at IS NOT NULL;

CREATE TRIGGER trg_orders_updated
BEFORE UPDATE ON orders
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =========================================================
-- ORDER_ITEMS (N por order)
-- =========================================================
CREATE TABLE order_items (
  id            BIGSERIAL PRIMARY KEY,
  order_id      TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id    TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,

  qty           INTEGER NOT NULL CHECK (qty > 0),
  unit_price    INTEGER NOT NULL CHECK (unit_price >= 0),
  line_total    INTEGER NOT NULL CHECK (line_total >= 0),

  CONSTRAINT uq_order_items_order_product UNIQUE (order_id, product_id)
);

CREATE INDEX idx_order_items_order_id ON order_items(order_id);
CREATE INDEX idx_order_items_product_id ON order_items(product_id);

-- =========================================================
-- PAYMENTS (1-1 con orders, opcional en fase "iniciado")
-- =========================================================
CREATE TABLE payments (
  id             BIGSERIAL PRIMARY KEY,
  order_id       TEXT UNIQUE REFERENCES orders(id) ON DELETE SET NULL,

  provider       TEXT NOT NULL CHECK (provider IN ('webpay','mercadopago','in_store')),
  status         TEXT NOT NULL DEFAULT 'initiated'
                 CHECK (status IN ('initiated','approved','rejected','voided')),

  amount         INTEGER NOT NULL CHECK (amount >= 0),
  transaction_id TEXT UNIQUE,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_payments_status ON payments(status);

-- =========================================================
-- STOCK_MOVEMENTS (auditoría)
-- =========================================================
CREATE TABLE stock_movements (
  id         BIGSERIAL PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  order_id   TEXT NULL REFERENCES orders(id) ON DELETE SET NULL,
  user_id    BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,

  movement_type TEXT NOT NULL CHECK (movement_type IN (
    'in','out','adjustment','reserve','release_reserve'
  )),
  qty        INTEGER NOT NULL CHECK (qty > 0),
  note       TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_stock_movements_product_created ON stock_movements(product_id, created_at DESC);
CREATE INDEX idx_stock_movements_order_id ON stock_movements(order_id);

-- =========================================================
-- SEED (categorías + productos + inventario)
-- =========================================================
INSERT INTO categories (name) VALUES
('herramientas'),
('fijaciones'),
('seguridad'),
('electricidad')
ON CONFLICT (name) DO NOTHING;

INSERT INTO products (id, sku, name, description, price, image_url, category_id, status, active)
VALUES
(
  'p1',
  'FER-TAL-001',
  'Taladro inalámbrico',
  'Taladro inalámbrico 18V, ideal para trabajos domésticos y profesionales.',
  49990,
  'https://picsum.photos/seed/ferretex1/600/400',
  (SELECT id FROM categories WHERE name='herramientas'),
  'offer',
  TRUE
),
(
  'p2',
  'FER-DES-010',
  'Set destornilladores',
  'Set de destornilladores de precisión y uso general.',
  12990,
  'https://picsum.photos/seed/ferretex2/600/400',
  (SELECT id FROM categories WHERE name='herramientas'),
  'new',
  TRUE
),
(
  'p3',
  'FER-TOR-050',
  'Caja de tornillos',
  'Caja surtida de tornillos para madera y metal.',
  7990,
  'https://picsum.photos/seed/ferretex3/600/400',
  (SELECT id FROM categories WHERE name='fijaciones'),
  'none',
  TRUE
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO inventory (product_id, stock_on_hand, stock_reserved, stock_min)
VALUES
('p1', 3, 0, 2),
('p2', 14, 0, 5),
('p3', 55, 0, 10)
ON CONFLICT (product_id) DO NOTHING;

COMMIT;
