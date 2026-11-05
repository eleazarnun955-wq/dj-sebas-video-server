import express from "express";
import cors from "cors";
import multer from "multer";

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }
});

app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.get("/", (_req, res) => {
  res.json({
    status: "online",
    name: "DJ SEBAS AI VIDEO",
    message: "Servidor conectado correctamente"
  });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/generate", upload.single("image"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Debes subir una imagen" });
  }

  if (!process.env.FAL_KEY) {
    return res.status(503).json({
      error: "Falta configurar FAL_KEY en Render"
    });
  }

  return res.status(501).json({
    status: "pending",
    message: "El servidor ya recibe imágenes. Falta conectar el motor de generación de video."
  });
});

const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => {
  console.log(`DJ SEBAS AI VIDEO activo en puerto ${port}`);
});
