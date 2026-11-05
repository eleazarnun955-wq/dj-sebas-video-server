import express from "express";
import cors from "cors";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }
});

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/status", (_req, res) => {
  res.json({
    status: "online",
    name: "DJ SEBAS AI VIDEO",
    videoEngineConfigured: Boolean(process.env.FAL_KEY)
  });
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.post("/api/generate", upload.single("image"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Selecciona una fotografía primero." });
  }
  if (!process.env.FAL_KEY) {
    return res.status(503).json({
      error: "La aplicación está lista, pero falta conectar la clave privada del motor de video (FAL_KEY)."
    });
  }
  return res.status(501).json({
    error: "La clave está configurada, pero el modelo de generación todavía debe conectarse."
  });
});

const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => {
  console.log(`DJ SEBAS AI VIDEO activo en puerto ${port}`);
});
