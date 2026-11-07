import express from "express";
import cors from "cors";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HF_SPACE = "https://cbensimon-wan2-2-fp8da-aoti-preview2.hf.space";
const HF_FN = "generate_video";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.fieldname === "image" && !["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) {
      return cb(new Error("Formato de imagen no válido. Usa JPG, PNG o WEBP."));
    }
    cb(null, true);
  }
});

app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/status", (_req, res) => {
  res.json({
    status: "online",
    name: "DJ SEBAS AI VIDEO",
    engine: "Wan 2.2 · Hugging Face ZeroGPU público",
    apiKeyRequired: false,
    note: "Motor gratuito compartido; puede haber fila de espera y límites diarios."
  });
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.post("/api/generate", upload.single("image"), async (req, res) => {
  const imageFile = req.file;
  if (!imageFile) return res.status(400).json({ error: "Selecciona una fotografía primero." });

  const userPrompt = String(req.body.prompt || "").trim();
  const style = String(req.body.style || "Libre").trim();
  const prompt = [
    userPrompt || "Make this image come alive, cinematic motion, smooth natural animation.",
    style !== "Libre" ? "Musical visual style: " + style + "." : "",
    "Keep the original person's identity, face, clothing, and number of people consistent. Natural realistic movement, stable anatomy, cinematic camera."
  ].filter(Boolean).join(" ");

  const requestedDuration = Number.parseFloat(req.body.duration || "3.5");
  const duration = Math.max(0.5, Math.min(4.5, Number.isFinite(requestedDuration) ? requestedDuration : 3.5));

  try {
    // Upload the image to the public Gradio Space (no API token required).
    const form = new FormData();
    form.append("files", new Blob([imageFile.buffer], { type: imageFile.mimetype }), imageFile.originalname || "photo.png");
    const uploadResponse = await fetch(HF_SPACE + "/gradio_api/upload", {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(60000)
    });
    if (!uploadResponse.ok) {
      const detail = await uploadResponse.text().catch(() => "");
      throw new Error("No se pudo subir la fotografía al motor gratuito (HTTP " + uploadResponse.status + "). " + detail.slice(0, 180));
    }
    const uploadedPaths = await uploadResponse.json();
    if (!Array.isArray(uploadedPaths) || !uploadedPaths[0]) {
      throw new Error("El motor gratuito no devolvió la ruta de la fotografía.");
    }

    const imagePath = uploadedPaths[0];
    const inputImage = {
      path: imagePath,
      url: HF_SPACE + "/gradio_api/file=" + imagePath,
      orig_name: imageFile.originalname || "photo.png",
      size: imageFile.size,
      mime_type: imageFile.mimetype,
      meta: { _type: "gradio.FileData" }
    };

    // Input order follows the public Space's generate_video Gradio function.
    const data = [
      inputImage,
      null,
      prompt,
      6,
      "色调艳丽, 过曝, 静态, 细节模糊不清, 字幕, 风格, 作品, 画作, 画面, 静止, 整体发灰, 最差质量, 低质量, JPEG压缩残留, 丑陋的, 残缺的, 多余的手指, 画得不好的手部, 画得不好的脸部, 畸形的, 毁容的, 形态畸形的肢体, 手指融合, 静止不动的画面, 杂乱的背景, 三条腿, 背景人很多, 倒着走",
      duration,
      1,
      1,
      42,
      true,
      6,
      "UniPCMultistep",
      3.0,
      16,
      false,
      true
    ];

    const createResponse = await fetch(HF_SPACE + "/gradio_api/call/" + HF_FN, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data }),
      signal: AbortSignal.timeout(60000)
    });
    if (!createResponse.ok) {
      const detail = await createResponse.text().catch(() => "");
      throw new Error("El motor gratuito rechazó la solicitud (HTTP " + createResponse.status + "). " + detail.slice(0, 200));
    }
    const created = await createResponse.json();
    if (!created.event_id) throw new Error("El motor gratuito no devolvió el identificador de generación.");

    const streamResponse = await fetch(HF_SPACE + "/gradio_api/call/" + HF_FN + "/" + encodeURIComponent(created.event_id), {
      method: "GET",
      headers: { Accept: "text/event-stream" },
      signal: AbortSignal.timeout(10 * 60 * 1000)
    });
    if (!streamResponse.ok || !streamResponse.body) {
      throw new Error("No se pudo abrir el resultado del motor gratuito (HTTP " + streamResponse.status + ").");
    }

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    Readable.fromWeb(streamResponse.body).pipe(res);
  } catch (error) {
    const detail = String(error?.message || error);
    console.error("DJ SEBAS Wan 2.2 error:", detail);
    if (!res.headersSent) return res.status(502).json({ error: detail.slice(0, 420) });
    res.end();
  }
});

app.use((err, _req, res, _next) => {
  console.error("REQUEST_ERROR", String(err?.message || err));
  res.status(err?.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
    error: err?.code === "LIMIT_FILE_SIZE"
      ? "La imagen supera 8 MB. Elige una fotografía más ligera."
      : err.message || "No se pudo procesar la solicitud."
  });
});

const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => console.log("DJ SEBAS AI VIDEO activo en puerto " + port + " · Wan 2.2 público"));
