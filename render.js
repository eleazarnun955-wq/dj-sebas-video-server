import express from "express";
import cors from "cors";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAGIC_HOUR_API = "https://api.magichour.ai";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3.5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) {
      return cb(new Error("Formato de imagen no válido. Usa JPG, PNG o WEBP."));
    }
    cb(null, true);
  }
});

app.use(cors());
app.use(express.json({ limit: "6mb" }));

app.use((req, res, next) => {
  const started = Date.now();
  console.log("HTTP_IN", JSON.stringify({
    method: req.method,
    path: req.path,
    contentLength: req.headers["content-length"] || null,
    contentType: req.headers["content-type"] || null
  }));
  res.on("finish", () => console.log("HTTP_OUT", JSON.stringify({
    method: req.method, path: req.path, status: res.statusCode,
    durationMs: Date.now() - started
  })));
  next();
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/status", (_req, res) => {
  res.json({
    status: "online",
    name: "DJ SEBAS AI VIDEO",
    videoEngineConfigured: true,
    engine: "Magic Hour · LTX-2.5",
    note: process.env.MAGIC_HOUR_API_KEY ? "API conectada; consumo sujeto a créditos disponibles." : "Falta configurar MAGIC_HOUR_API_KEY en Render."
  });
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.post("/api/generate", upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Selecciona una fotografía primero." });
  const apiKey = process.env.MAGIC_HOUR_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "Falta configurar MAGIC_HOUR_API_KEY en Render." });

  const promptText = String(req.body.prompt || "").trim();
  const style = String(req.body.style || "Libre").trim();
  const duration = Math.min(60, Math.max(1, Number.parseInt(req.body.duration || "5", 10) || 5));
  const prompt = `${promptText || "La persona de la fotografía cobra vida y baila con movimientos naturales y fluidos"}. Estilo musical: ${style}. Mantener la apariencia, rostro y ropa de la persona. Cámara estable, movimiento natural, buena iluminación.`;
  const headers = { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "Content-Type": "application/json" };

  try {
    const extByType = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
    const extension = extByType[req.file.mimetype];
    if (!extension) return res.status(400).json({ error: "Formato de imagen no válido." });

    // 1) Obtener URL temporal y subir la fotografía a Magic Hour.
    const uploadResponse = await fetch(`${MAGIC_HOUR_API}/v1/files/upload-urls`, {
      method: "POST", headers,
      body: JSON.stringify({ items: [{ type: "image", extension }] }),
      signal: AbortSignal.timeout(30000)
    });
    const uploadData = await uploadResponse.json().catch(() => ({}));
    if (!uploadResponse.ok || !uploadData.items?.[0]?.upload_url || !uploadData.items?.[0]?.file_path) {
      throw new Error(uploadData.message || uploadData.error || `Magic Hour upload URL HTTP ${uploadResponse.status}`);
    }
    const asset = uploadData.items[0];
    const putResponse = await fetch(asset.upload_url, {
      method: "PUT",
      headers: { "Content-Type": req.file.mimetype },
      body: req.file.buffer,
      signal: AbortSignal.timeout(60000)
    });
    if (!putResponse.ok) throw new Error(`No se pudo subir la imagen a Magic Hour (HTTP ${putResponse.status}).`);

    // 2) Crear generación image-to-video con LTX-2.5 (modelo gratuito disponible según créditos).
    const createResponse = await fetch(`${MAGIC_HOUR_API}/v1/image-to-video`, {
      method: "POST", headers,
      body: JSON.stringify({
        name: "DJ SEBAS AI VIDEO",
        end_seconds: duration,
        model: "ltx-2.5",
        resolution: "480p",
        audio: true,
        style: { prompt },
        assets: { image_file_path: asset.file_path }
      }),
      signal: AbortSignal.timeout(60000)
    });
    const created = await createResponse.json().catch(() => ({}));
    if (!createResponse.ok || !created.id) {
      const message = created.message || created.error || `Magic Hour respondió HTTP ${createResponse.status}`;
      const status = createResponse.status === 402 ? 402 : createResponse.status === 401 ? 401 : 502;
      return res.status(status).json({ error: message });
    }

    // 3) Consultar el proyecto hasta que esté listo.
    let video = null;
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      const statusResponse = await fetch(`${MAGIC_HOUR_API}/v1/video-projects/${encodeURIComponent(created.id)}`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(30000)
      });
      const statusData = await statusResponse.json().catch(() => ({}));
      if (!statusResponse.ok) throw new Error(statusData.message || `No se pudo consultar el video (HTTP ${statusResponse.status}).`);
      if (statusData.status === "complete") {
        video = statusData.downloads?.[0]?.url;
        if (!video) throw new Error("Magic Hour terminó el trabajo pero no devolvió el enlace del video.");
        break;
      }
      if (statusData.status === "error" || statusData.status === "canceled") {
        throw new Error(statusData.error?.message || `La generación terminó con estado: ${statusData.status}`);
      }
    }
    if (!video) throw new Error("Magic Hour sigue procesando el video. Intenta consultar el proyecto más tarde.");

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    res.write(`event: complete\\ndata: ${JSON.stringify([{ url: video }])}\\n\\n`);
    res.end();
  } catch (error) {
    const detail = String(error?.message || error);
    console.error("Magic Hour image-to-video error:", detail);
    if (!res.headersSent) return res.status(502).json({ error: "No se pudo generar el video con Magic Hour: " + detail.slice(0, 260) });
    res.end();
  }
});

app.use((err, _req, res, _next) => {
  console.error("REQUEST_ERROR", String(err?.message || err));
  res.status(err?.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
    error: err?.code === "LIMIT_FILE_SIZE"
      ? "La fotografía supera el máximo de 3.5 MB que acepta Magic Hour."
      : err.message || "No se pudo procesar la solicitud."
  });
});

const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => console.log(`DJ SEBAS AI VIDEO activo en puerto ${port}`));
