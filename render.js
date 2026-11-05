import express from "express";
import cors from "cors";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Transform } from "node:stream";

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HF_SPACE_BASE = "https://zerogpu-aoti-wan2-2-fp8da-aoti-faster.hf.space";
const HF_FN_NAME = "generate_video";
const pendingImages = new Map();

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

// Lightweight request diagnostics: never log image contents or secrets.
app.use((req, res, next) => {
  const started = Date.now();
  console.log("HTTP_IN", JSON.stringify({
    method: req.method,
    path: req.path,
    contentLength: req.headers["content-length"] || null,
    contentType: req.headers["content-type"] || null,
    origin: req.headers.origin || null
  }));
  res.on("finish", () => console.log("HTTP_OUT", JSON.stringify({
    method: req.method, path: req.path, status: res.statusCode,
    durationMs: Date.now() - started
  })));
  res.on("close", () => {
    if (!res.writableFinished) console.warn("HTTP_CLOSED_EARLY", JSON.stringify({
      method: req.method, path: req.path, durationMs: Date.now() - started
    }));
  });
  next();
});
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/status", (_req, res) => {
  res.json({
    status: "online",
    name: "DJ SEBAS AI VIDEO",
    videoEngineConfigured: true,
    engine: "Wan 2.2 Fast · Hugging Face ZeroGPU",
    note: "GPU compartida gratuita; puede haber espera o límites."
  });
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// Serve uploaded images temporarily so Gradio can fetch them directly.
// This avoids relying on a Space-specific upload route that currently returns 404.
app.get("/api/hf-image/:id", (req, res) => {
  const file = pendingImages.get(req.params.id);
  if (!file) return res.status(404).send("Imagen temporal no encontrada.");
  res.setHeader("Content-Type", file.mimetype);
  res.setHeader("Content-Length", String(file.buffer.length));
  res.setHeader("Cache-Control", "no-store");
  res.end(file.buffer);
});

app.post("/api/generate", upload.single("image"), async (req, res) => {
  console.log("GENERATE_ROUTE_ENTER", JSON.stringify({
    hasFile: Boolean(req.file),
    fileSize: req.file?.size || 0,
    fileType: req.file?.mimetype || null
  }));
  if (!req.file) {
    return res.status(400).json({ error: "Selecciona una fotografía primero." });
  }

  const promptText = String(req.body.prompt || "").trim();
  const style = String(req.body.style || "Libre").trim();
  const movement = promptText || "La persona de la fotografía cobra vida y baila con movimientos naturales y fluidos";
  const prompt = `${movement}. Estilo musical: ${style}. Mantener la apariencia, rostro y ropa de la persona de la fotografía. Cámara estable, movimiento natural, buena iluminación.`;

  try {
    const hfToken = String(process.env.HF_TOKEN || "").trim();
    if (!hfToken) throw new Error("Falta HF_TOKEN en los secretos de Render.");

    const hfHeaders = { Authorization: `Bearer ${hfToken}` };

    // Give the public Gradio Space a temporary URL for the image instead of
    // calling its unavailable /gradio_api/upload route (currently HTTP 404).
    const imageId = crypto.randomUUID();
    pendingImages.set(imageId, {
      buffer: req.file.buffer,
      mimetype: req.file.mimetype
    });
    const publicBase = String(process.env.RENDER_EXTERNAL_URL || `https://${req.get("host")}`).replace(/\/$/, "");
    const imageUrl = `${publicBase}/api/hf-image/${imageId}`;
    const cleanupTimer = setTimeout(() => pendingImages.delete(imageId), 10 * 60 * 1000);
    cleanupTimer.unref?.();

    const inputImage = {
      path: imageUrl,
      url: imageUrl,
      orig_name: req.file.originalname || "foto.jpg",
      size: req.file.size,
      mime_type: req.file.mimetype,
      meta: { _type: "gradio.FileData" }
    };

    // Exact input order for the public ZeroGPU-AOTI Wan 2.2 Fast Space:
    // input_image, prompt, negative_prompt, duration_seconds,
    // guidance_scale, guidance_scale_2, steps, seed, randomize_seed.
    const data = [
      inputImage,
      prompt,
      "overexposed, static, blurry details, subtitles, watermark, low quality, deformed hands, extra fingers, distorted face, malformed limbs, frozen frame, cluttered background",
      4.5,
      1,
      1,
      4,
      42,
      true
    ];

    console.log("HF_JOB_SUBMIT", JSON.stringify({ space: HF_SPACE_BASE, fn: HF_FN_NAME }));
    const jobResponse = await fetch(`${HF_SPACE_BASE}/gradio_api/call/${HF_FN_NAME}`, {
      method: "POST",
      headers: { ...hfHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ data }),
      signal: AbortSignal.timeout(60000)
    });

    if (!jobResponse.ok) {
      const detail = await jobResponse.text().catch(() => "");
      throw new Error(`El motor gratuito rechazó la solicitud (HTTP ${jobResponse.status}). ${detail.slice(0, 220)}`);
    }

    const job = await jobResponse.json();
    if (!job.event_id) {
      throw new Error("El motor gratuito no devolvió el identificador de generación.");
    }

    const eventResponse = await fetch(
      `${HF_SPACE_BASE}/gradio_api/call/${HF_FN_NAME}/${job.event_id}`,
      { headers: { ...hfHeaders, Accept: "text/event-stream" }, signal: req.signal }
    );

    if (!eventResponse.ok || !eventResponse.body) {
      throw new Error(`No se pudo abrir el resultado del motor (HTTP ${eventResponse.status}).`);
    }

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");

    const stream = Readable.fromWeb(eventResponse.body);
    let sseBuffer = "";
    const sseDiagnostics = new Transform({
      transform(chunk, _encoding, callback) {
        sseBuffer += chunk.toString("utf8");
        const frames = sseBuffer.split(/\r?\n\r?\n/);
        sseBuffer = frames.pop() || "";
        for (const frame of frames) {
          const eventName = frame.match(/^event:\s*(.+)$/m)?.[1]?.trim() || "message";
          const dataLines = frame.split(/\r?\n/).filter(line => line.startsWith("data:"));
          const payload = dataLines.map(line => line.slice(5).trim()).join("\n");
          if (eventName === "error") {
            console.error("HF_SPACE_SSE_ERROR", JSON.stringify({
              eventId: job.event_id,
              payload: payload || "(sin data)",
              frame: frame.slice(0, 2000)
            }));
          }
        }
        callback(null, chunk);
      },
      flush(callback) {
        if (sseBuffer.trim()) {
          const eventName = sseBuffer.match(/^event:\s*(.+)$/m)?.[1]?.trim() || "message";
          if (eventName === "error") {
            console.error("HF_SPACE_SSE_ERROR_FINAL", JSON.stringify({
              eventId: job.event_id,
              frame: sseBuffer.slice(0, 2000)
            }));
          }
        }
        callback();
      }
    });
    stream.on("end", () => {
      clearTimeout(cleanupTimer);
      pendingImages.delete(imageId);
    });
    stream.on("error", (error) => {
      console.error("Error en el flujo de video:", error);
      if (!res.headersSent) res.status(502);
      res.end();
    });
    res.on("close", () => {
      if (!stream.destroyed) stream.destroy();
      clearTimeout(cleanupTimer);
      pendingImages.delete(imageId);
    });
    stream.pipe(sseDiagnostics).pipe(res);
  } catch (error) {
    const detail = String(error?.message || error);
    console.error("Wan 2.2 public Space error:", detail);
    if (!res.headersSent) {
      const status = /429|queue|busy|rate.?limit/i.test(detail) ? 503 : 502;
      return res.status(status).json({
        error: /429|queue|busy|rate.?limit/i.test(detail)
          ? "El motor gratuito está ocupado. Espera un poco y vuelve a intentarlo."
          : "No se pudo iniciar la generación gratuita: " + detail.slice(0, 240)
      });
    }
    res.end();
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(400).json({ error: err.message || "No se pudo procesar la solicitud." });
});


const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => console.log(`DJ SEBAS AI VIDEO activo en puerto ${port}`));
