import express from "express";
import cors from "cors";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEAPI_API = "https://api.deapi.ai/api/v2";
const DEAPI_MODEL = "Ltx2_3_22B_Dist_INT8";
const DEAPI_COST_USD = 0.047;
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
    method: req.method, path: req.path,
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
  const configured = Boolean(process.env.DEAPI_API_KEY);
  res.json({
    status: "online",
    name: "DJ SEBAS AI VIDEO",
    videoEngineConfigured: configured,
    engine: "deAPI · LTX-2.3 22B",
    note: configured
      ? "Motor image-to-video configurado. Coste publicado: USD $0.047 por clip; sujeto a límites de la cuenta y de la clave."
      : "Falta configurar DEAPI_API_KEY en Render. No se enviarán solicitudes ni se generarán cargos."
  });
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.post("/api/generate", upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Selecciona una fotografía primero." });
  const apiKey = process.env.DEAPI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      error: "El motor de video aún no está conectado. Falta configurar la clave de deAPI en Render."
    });
  }

  const promptText = String(req.body.prompt || "").trim();
  const style = String(req.body.style || "Libre").trim();
  const requestedDuration = Number.parseInt(req.body.duration || "5", 10) || 5;
  const duration = Math.min(10, Math.max(2, requestedDuration));
  const frames = Math.min(241, Math.max(49, Math.round(duration * 24)));
  const movement = promptText || "La persona de la fotografía cobra vida y baila con movimientos naturales y fluidos";
  const prompt = `${movement}. Estilo musical: ${style}. Mantener la apariencia, rostro y ropa de la persona. Movimiento corporal natural, cámara estable, iluminación cuidada y composición vertical para redes sociales.`;

  try {
    console.log("DEAPI_JOB_SUBMIT", JSON.stringify({
      model: DEAPI_MODEL, duration, frames, imageBytes: req.file.size,
      estimatedCostUsd: DEAPI_COST_USD
    }));

    const form = new FormData();
    form.append("model", DEAPI_MODEL);
    form.append("prompt", prompt);
    form.append("first_frame_image", new Blob([req.file.buffer], { type: req.file.mimetype }), req.file.originalname || "photo.jpg");
    form.append("width", "768");
    form.append("height", "768");
    form.append("frames", String(frames));
    form.append("fps", "24");

    const submitResponse = await fetch(`${DEAPI_API}/videos/animations`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Accept": "application/json" },
      body: form,
      signal: AbortSignal.timeout(120000)
    });
    const submitRaw = await submitResponse.text();
    let submitJson;
    try { submitJson = JSON.parse(submitRaw); } catch { submitJson = null; }
    if (!submitResponse.ok) {
      const detail = submitJson?.message || submitJson?.error || submitRaw.slice(0, 240) || "Sin detalles del proveedor.";
      throw new Error(`deAPI respondió HTTP ${submitResponse.status}: ${detail}`);
    }

    const requestId = submitJson?.data?.request_id || submitJson?.request_id;
    if (!requestId) throw new Error("deAPI aceptó la solicitud, pero no devolvió un identificador de trabajo.");
    console.log("DEAPI_JOB_ACCEPTED", JSON.stringify({ requestId }));

    const deadline = Date.now() + 10 * 60 * 1000;
    let job = null;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      const statusResponse = await fetch(`${DEAPI_API}/jobs/${encodeURIComponent(requestId)}`, {
        headers: { "Authorization": `Bearer ${apiKey}`, "Accept": "application/json" },
        signal: AbortSignal.timeout(30000)
      });
      const statusRaw = await statusResponse.text();
      let statusJson;
      try { statusJson = JSON.parse(statusRaw); } catch { statusJson = null; }
      if (!statusResponse.ok) {
        const detail = statusJson?.message || statusJson?.error || statusRaw.slice(0, 200);
        throw new Error(`No se pudo consultar el trabajo en deAPI (HTTP ${statusResponse.status}): ${detail}`);
      }
      job = statusJson?.data || statusJson;
      if (["done", "completed", "success"].includes(String(job?.status || "").toLowerCase())) break;
      if (["error", "failed", "cancelled", "canceled"].includes(String(job?.status || "").toLowerCase())) {
        throw new Error(job?.error || job?.message || "deAPI no pudo generar el video.");
      }
    }

    const videoUrl = job?.result_url || job?.video_url || job?.result?.url;
    if (!videoUrl || !/^https:\/\//i.test(videoUrl)) {
      throw new Error(job?.status ? `El trabajo terminó con estado "${job.status}", pero no devolvió un enlace MP4 válido.` : "La generación tardó más de 10 minutos. Inténtalo de nuevo más tarde.");
    }

    console.log("DEAPI_JOB_SUCCESS", JSON.stringify({ requestId, hasVideoUrl: true }));
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    res.write(`event: complete\ndata: ${JSON.stringify([{ url: videoUrl }])}\n\n`);
    res.end();
  } catch (error) {
    const detail = String(error?.message || error);
    console.error("deAPI image-to-video error:", detail);
    if (!res.headersSent) {
      const limited = /429|rate.?limit|quota|insufficient|balance|spending.?limit/i.test(detail);
      return res.status(limited ? 503 : 502).json({
        error: limited
          ? "deAPI alcanzó el límite de uso o saldo disponible. No se harán más intentos automáticos."
          : "No se pudo generar el video con deAPI: " + detail.slice(0, 260)
      });
    }
    res.end();
  }
});

app.use((err, _req, res, _next) => {
  console.error("REQUEST_ERROR", String(err?.message || err));
  res.status(err?.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
    error: err?.code === "LIMIT_FILE_SIZE"
      ? "La fotografía supera el máximo de 3.5 MB."
      : err.message || "No se pudo procesar la solicitud."
  });
});

const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => console.log(`DJ SEBAS AI VIDEO activo en puerto ${port}`));
