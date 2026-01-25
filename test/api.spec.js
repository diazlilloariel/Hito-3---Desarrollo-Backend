import request from "supertest";
import http from "http";
import app from "../app.js";
import { pool } from "../consultas.js";

let server;

let customerToken = "";
let staffToken = "";
let productId = "";
let createdOrderId = "";

// Helpers
const uniqueEmail = (prefix) => `${prefix}.${Date.now()}@ferretex-demo.cl`;

async function registerAndLogin({ role }) {
  const email = uniqueEmail(role);
  const password = "123456";
  const name = role === "staff" ? "Staff Demo" : "Cliente Demo";

  const r1 = await request(server).post("/api/auth/register").send({
    name,
    email,
    password,
    role,
  });
  expect(r1.statusCode).toBe(201);

  const r2 = await request(server).post("/api/auth/login").send({ email, password });
  expect(r2.statusCode).toBe(200);
  expect(typeof r2.body.token).toBe("string");

  return r2.body.token;
}

beforeAll(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));

  customerToken = await registerAndLogin({ role: "customer" });
  staffToken = await registerAndLogin({ role: "staff" });

  // 1) Trae productos
  const res = await request(server).get("/api/products");
  expect(res.statusCode).toBe(200);
  expect(Array.isArray(res.body)).toBe(true);
  expect(res.body.length).toBeGreaterThan(0);

  // 2) Elige producto con stock > 0 (si existe)
  const inStock = res.body.find((p) => Number(p.stock ?? 0) > 0) ?? res.body[0];
  productId = inStock.id;
  expect(productId).toBeTruthy();

  // 3) Blindaje: en TEST garantiza stock disponible suficiente
  // Evita 409 por stock agotado o reservas acumuladas
  await pool.query(
    `
    UPDATE inventory
    SET stock_on_hand = GREATEST(stock_on_hand, stock_reserved + 50)
    WHERE product_id = $1
    `,
    [productId]
  );
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

describe("API Ferretex", () => {
  test("GET /api/health -> 200 y ok true", async () => {
    const res = await request(server).get("/api/health");
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test("GET /api/products -> 200 y array", async () => {
    const res = await request(server).get("/api/products");
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test("GET /api/products/:id inexistente -> 404", async () => {
    const res = await request(server).get("/api/products/no-existe");
    expect(res.statusCode).toBe(404);
  });

  test("POST /api/orders sin token -> 401", async () => {
    const res = await request(server).post("/api/orders").send({});
    expect(res.statusCode).toBe(401);
  });

  test("POST /api/orders con token customer -> 201", async () => {
    const orderId = `FX-${Date.now()}`;

    const res = await request(server)
      .post("/api/orders")
      .set("Authorization", `Bearer ${customerToken}`)
      .send({
        id: orderId,
        mode: "pickup",
        phone: "+56911112222",
        address: null,
        notes: "Pedido demo",
        items: [{ productId, qty: 1 }],
      });

    expect(res.statusCode).toBe(201);
    expect(res.body.orderId).toBe(orderId);

    createdOrderId = orderId;
  });

  test("PATCH /api/orders/:id/status con staff -> 200 y status actualizado", async () => {
    expect(createdOrderId).toBeTruthy();

    const res = await request(server)
      .patch(`/api/orders/${createdOrderId}/status`)
      .set("Authorization", `Bearer ${staffToken}`)
      .send({ status: "PREPARING" });

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("preparing");
  });
});
