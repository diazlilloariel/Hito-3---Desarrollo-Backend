import "./env.js";
import app from "./app.js";

const PORT = process.env.PORT || 3000;

if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.log(`API Ferretex corriendo en http://localhost:${PORT}`);
  });
}

export default app;
