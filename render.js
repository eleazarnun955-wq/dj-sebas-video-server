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
    videoEngineConfigured: true,
    engine: "Wan 2.2 Fast · Hugging Face ZeroGPU",
    note: "GPU compartida gratuita; puede haber espera o límites."
  });
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.post("/api/generate", upload.single("image"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Selecciona una fotografía primero." });
  }

  const promptText = String(req.body.prompt || "").trim();
  const style = String(req.body.style || "Libre").trim();
  const movement = promptText || "La persona de la fotografía cobra vida y baila con movimientos naturales y fluidos";
  const prompt = `${movement}. Estilo musical: ${style}. Mantener la apariencia, rostro y ropa de la persona de la fotografía. Cámara estable, movimiento natural, buena iluminación.`;

  try {
    // Hugging Face Space Gradio upload: the public GPU Space does not require an API token.
    const imageForm = new FormData();
    const imageBlob = new Blob([req.file.buffer], { type: req.file.mimetype });
    imageForm.append("files", imageBlob, req.file.originalname || "foto.jpg");

    const uploadResponse = await fetch(`${HF_SPACE_BASE}/gradio_api/upload`, {
      method: "POST",
      body: imageForm,
      signal: AbortSignal.timeout(60000)
    });

    if (!uploadResponse.ok) {
      const detail = await uploadResponse.text().catch(() => "");
      throw new Error(`No se pudo subir la foto al motor gratuito (HTTP ${uploadResponse.status}). ${detail.slice(0, 180)}`);
    }

    const uploadedPaths = await uploadResponse.json();
    if (!Array.isArray(uploadedPaths) || !uploadedPaths[0]) {
      throw new Error("El motor gratuito no confirmó la recepción de la fotografía.");
    }

    const imagePath = uploadedPaths[0];
    const inputImage = {
      path: imagePath,
      url: `${HF_SPACE_BASE}/gradio_api/file=${imagePath}`,
      orig_name: req.file.originalname || "foto.jpg",
      size: req.file.size,
      mime_type: req.file.mimetype,
      meta: { _type: "gradio.FileData" }
    };

    // API del Space zerogpu-aoti/wan2-2-fp8da-aoti-faster.
    // generate_video(input_image, prompt, steps, negative_prompt, duration_seconds,
    //                guidance_scale, guidance_scale_2, seed, randomize_seed)
    // Orden real de ui_inputs en app.py:
    // input_image, prompt, steps, negative_prompt, duration_seconds,
    // guidance_scale, guidance_scale_2, seed, randomize_seed.
    const data = [
      inputImage,
      prompt,
      4,
      "色调艳丽, 过曝, 静态, 细节模糊不清, 字幕, 风格, 作品, 画作, 画面, 静止, 整体发灰, 最差质量, 低质量, JPEG压缩残留, 丑陋的, 残缺的, 多余的手指, 画得不好的手部, 画得不好的脸部, 畸形的, 毁容的, 形态畸形的肢体, 手指融合, 静止不动的画面, 杂乱的背景, 三条腿, 背景人很多, 倒着走",
      2.5,
      1,
      1,
      42,
      true
    ];

    const jobResponse = await fetch(`${HF_SPACE_BASE}/gradio_api/call/${HF_FN_NAME}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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

    // Stream Gradio's Server-Sent Events through Render. The browser reads the
    // completed event and then plays the MP4 from the public Space.
    const eventResponse = await fetch(
      `${HF_SPACE_BASE}/gradio_api/call/${HF_FN_NAME}/${job.event_id}`,
      { headers: { Accept: "text/event-stream" }, signal: req.signal }
    );

    if (!eventResponse.ok || !eventResponse.body) {
      throw new Error(`No se pudo abrir el resultado del motor (HTTP ${eventResponse.status}).`);
    }

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");

    const stream = Readable.fromWeb(eventResponse.body);
    // Inspecciona eventos SSE sin alterar el flujo que recibe el navegador.
    // Gradio puede enviar event:error con data:null; registramos el evento real
    // para distinguir errores de GPU, cola, validación o cambios del Space.
    let sseBuffer = "";
    const sseDiagnostics = new Transform({
      transform(chunk, _encoding, callback) {
        const textChunk = chunk.toString("utf8");
        sseBuffer += textChunk;
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
    stream.on("error", (error) => {
      console.error("Error en el flujo de video:", error);
      if (!res.headersSent) res.status(502);
      res.end();
    });
    res.on("close", () => {
      if (!stream.destroyed) stream.destroy();
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
