import express from "express";
import cors from "cors";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InferenceClient } from "@huggingface/inference";

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) {
      return cb(new Error("Formato de imagen no válido. Usa JPG, PNG o WEBP."));
    }
    cb(null, true);
  }
});

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/status", (_req, res) => {
  res.json({
    status: "online",
    name: "DJ SEBAS AI VIDEO",
    videoEngineConfigured: Boolean(process.env.HF_TOKEN),
    engine: "Hugging Face"
  });
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.post("/api/generate", upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Selecciona una fotografía primero." });
  if (!process.env.HF_TOKEN) {
    return res.status(503).json({ error: "Falta configurar HF_TOKEN en los secretos de Render. Crea un token de Hugging Face con permiso Inference Providers." });
  }

  const promptText = String(req.body.prompt || "").trim();
  const style = String(req.body.style || "Libre").trim();
  const movement = promptText || "La persona de la fotografía cobra vida y baila con movimientos naturales y fluidos";
  const prompt = `${movement}. Estilo musical: ${style}. Mantener la apariencia, rostro y ropa de la persona de la fotografía. Cámara estable, movimiento natural, buena iluminación.`;

  try {
    const client = new InferenceClient(process.env.HF_TOKEN);
    const video = await client.imageToVideo({
      inputs: new Blob([req.file.buffer], { type: req.file.mimetype }),
      model: process.env.HF_VIDEO_MODEL || "Wan-AI/Wan2.2-I2V-A14B",
      provider: "auto",
      prompt
    });
    const bytes = Buffer.from(await video.arrayBuffer());
    if (!bytes.length) throw new Error("Hugging Face devolvió un video vacío.");
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="dj-sebas-video.mp4"');
    res.setHeader("Content-Length", String(bytes.length));
    return res.status(200).send(bytes);
  } catch (error) {
    const detail = String(error?.message || error);
    console.error("Hugging Face video generation error:", detail);
    if (/401|403|unauthorized|forbidden|token/i.test(detail)) return res.status(401).json({ error: "Hugging Face no aceptó el token. Revisa que tenga el permiso «Make calls to Inference Providers»." });
    if (/402|quota|credit|billing|payment/i.test(detail)) return res.status(402).json({ error: "Hugging Face indica que no hay créditos disponibles para este modelo. Puede requerir saldo o esperar al reinicio de la cuota." });
    if (/not supported|provider|model.*not found|no provider/i.test(detail)) return res.status(503).json({ error: "El modelo de video no tiene un proveedor disponible en este momento. Revisa su disponibilidad en Hugging Face." });
    return res.status(502).json({ error: "No se pudo generar el video: " + detail.slice(0, 240) });
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(400).json({ error: err.message || "No se pudo procesar la solicitud." });
});

const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => console.log(`DJ SEBAS AI VIDEO activo en puerto ${port}`));
