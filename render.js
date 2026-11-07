import express from "express";
import cors from "cors";
import multer from "multer";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import ffmpegPath from "ffmpeg-static";

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HF_SPACE = "https://cbensimon-wan2-2-fp8da-aoti-preview2.hf.space";
const OUTPUT_DIR = path.join(os.tmpdir(), "dj-sebas-generated");
await fs.mkdir(OUTPUT_DIR, { recursive: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 2 },
  fileFilter: (_req, file, cb) => {
    const images = ["image/jpeg", "image/png", "image/webp"];
    const audios = ["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/aac", "audio/flac", "audio/mp4", "audio/x-m4a", "audio/ogg", "audio/webm", "audio/opus"];
    if (file.fieldname === "image" && !images.includes(file.mimetype)) return cb(new Error("Formato de imagen no válido. Usa JPG, PNG o WEBP."));
    if (file.fieldname === "audio" && !audios.includes(file.mimetype)) return cb(new Error("Formato de música no válido. Usa MP3, WAV, M4A, AAC, FLAC u OGG."));
    cb(null, true);
  }
});

app.use(cors());
app.use(express.static(path.join(__dirname, "public")));
app.use("/generated", express.static(OUTPUT_DIR, { fallthrough: false, maxAge: "1h" }));

app.get("/api/status", (_req, res) => res.json({
  status: "online",
  name: "DJ SEBAS AI VIDEO",
  videoEngineConfigured: true,
  engine: "Wan 2.2 público · sin claves API",
  audioMixing: Boolean(ffmpegPath),
  note: "Las instrucciones de movimiento se preparan localmente; Wan 2.2 anima la fotografía y FFmpeg une el clip con la canción."
}));
app.get("/health", (_req, res) => res.json({ status: "ok" }));

function getOutputText(data) {
  if (data.output_text) return data.output_text;
  return (data.output || []).flatMap(x => x.content || [])
    .filter(x => x.type === "output_text").map(x => x.text).join("\n");
}
function getVideoPath(value) {
  if (!value) return null;
  if (Array.isArray(value)) return getVideoPath(value[0]);
  if (typeof value === "object") return getVideoPath(value.video || value.url || value.path);
  if (typeof value !== "string") return null;
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("/gradio_api/file=")) return HF_SPACE + value;
  return HF_SPACE + "/gradio_api/file=" + value;
}
async function runFfmpeg(args) {
  if (!ffmpegPath) throw new Error("No se encontró FFmpeg en el servidor.");
  await new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk.toString(); if (stderr.length > 12000) stderr = stderr.slice(-12000); });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error("FFmpeg no pudo combinar el video y la canción: " + stderr.slice(-900))));
  });
}
async function makeWanClip(imageFile, prompt, duration) {
  const form = new FormData();
  form.append("files", new Blob([imageFile.buffer], { type: imageFile.mimetype }), imageFile.originalname || "photo.png");
  const up = await fetch(HF_SPACE + "/gradio_api/upload", { method: "POST", body: form, signal: AbortSignal.timeout(60000) });
  if (!up.ok) throw new Error("El motor de video no recibió la fotografía (HTTP " + up.status + ").");
  const paths = await up.json();
  if (!Array.isArray(paths) || !paths[0]) throw new Error("El motor de video no devolvió la fotografía cargada.");
  const imagePath = paths[0];
  const inputImage = {
    path: imagePath, url: HF_SPACE + "/gradio_api/file=" + imagePath,
    orig_name: imageFile.originalname || "photo.png", size: imageFile.size,
    mime_type: imageFile.mimetype, meta: { _type: "gradio.FileData" }
  };
  // Match the current public Space API defaults and enable its Safe Mode.
  // Safe Mode reserves extra ZeroGPU time for busy or slow generations.
  const data = [
    inputImage, null, prompt, 4,
    "色调艳丽, 过曝, 静态, 细节模糊不清, 字幕, 风格, 作品, 画作, 画面, 静止, 整体发灰, 最差质量, 低质量, JPEG压缩残留, 丑陋的, 残缺的, 多余的手指, 画得不好的手部, 画得不好的脸部, 畸形的, 毁容的, 形态畸形的肢体, 手指融合, 静止不动的画面, 杂乱的背景, 三条腿, 背景人很多, 倒着走",
    duration, 1, 1, 42, true, 5, "UniPCMultistep", 3.0, 16, true, true
  ];
  let lastError = "Wan 2.2 no completó la generación.";
  // Public ZeroGPU Spaces can fail transiently when their shared GPU is busy.
  // Retry once with a fresh Gradio event instead of immediately failing the user's job.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const start = await fetch(HF_SPACE + "/gradio_api/call/generate_video", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data }), signal: AbortSignal.timeout(60000)
      });
      if (!start.ok) {
        const message = "Wan 2.2 rechazó la generación (HTTP " + start.status + ").";
        if (attempt < 2 && [429, 500, 502, 503, 504].includes(start.status)) throw new Error(message);
        throw new Error(message + " El Space público puede estar saturado o sin cuota ZeroGPU.");
      }
      const created = await start.json();
      if (!created.event_id) throw new Error("Wan 2.2 no devolvió el identificador de generación.");
      const result = await fetch(HF_SPACE + "/gradio_api/call/generate_video/" + encodeURIComponent(created.event_id), {
        headers: { Accept: "text/event-stream" }, signal: AbortSignal.timeout(5 * 60 * 1000)
      });
      if (!result.ok || !result.body) {
        const message = "No se pudo consultar el resultado de Wan 2.2 (HTTP " + result.status + ").";
        if (attempt < 2 && [429, 500, 502, 503, 504].includes(result.status)) throw new Error(message);
        throw new Error(message);
      }
      const body = await result.text();
      const blocks = body.split("\n\n");
      let completed = false;
      for (const block of blocks) {
        const event = block.match(/^event:\s*(\S+)/m)?.[1];
        const raw = block.split("\n").filter(x => x.startsWith("data:")).map(x => x.slice(5).trim()).join("\n");
        if (event === "error") {
          let detail = raw || "";
          if (!detail || detail === "null" || detail === "undefined") {
            detail = "el Space público no explicó el fallo; probablemente está ocupado o alcanzó el límite temporal de ZeroGPU.";
          }
          throw new Error("Wan 2.2: " + detail);
        }
        if (event === "complete") {
          let payload;
          try { payload = JSON.parse(raw); } catch { throw new Error("Wan 2.2 devolvió un resultado ilegible."); }
          const url = getVideoPath(payload);
          if (!url) throw new Error("Wan 2.2 terminó pero no entregó un archivo de video.");
          const videoResponse = await fetch(url, { signal: AbortSignal.timeout(120000) });
          if (!videoResponse.ok) throw new Error("No se pudo descargar el clip generado (HTTP " + videoResponse.status + ").");
          completed = true;
          return Buffer.from(await videoResponse.arrayBuffer());
        }
      }
      if (!completed) throw new Error("Wan 2.2 cerró la conexión antes de entregar el video.");
    } catch (error) {
      lastError = String(error?.message || error);
      if (attempt >= 2) break;
      console.warn("Wan 2.2 intento " + attempt + " falló; se reintentará una vez:", lastError);
      await new Promise(resolve => setTimeout(resolve, 12000));
    }
  }
  throw new Error(lastError + " Se hicieron 2 intentos; vuelve a probar más tarde si el Space sigue ocupado.");
}


const jobs = new Map();

async function runGenerationJob(job, imageFile, audioFile, options) {
  const work = path.join(os.tmpdir(), "dj-sebas-" + job.id);
  await fs.mkdir(work, { recursive: true });
  try {
    job.status = "preparing";
    job.message = "Preparando las instrucciones de movimiento sin claves API…";
    const style = String(options.style || "Libre");
    const userPrompt = String(options.userPrompt || "la persona bailando con energía y movimientos naturales");
    const prompt = [
      "Create a natural image-to-video animation for DJ SEBAS AI VIDEO.",
      "Style: " + style + ".",
      "Action requested: " + userPrompt + ".",
      "Animate the visible person or people with expressive, rhythmic full-body dance movements, natural timing, realistic anatomy, and smooth continuous motion.",
      "Preserve each person's identity, face, clothing, body proportions, and the original number of people.",
      "Keep the camera stable with subtle cinematic movement and preserve the scene background.",
      "Create a short seamless-feeling dance clip suitable for looping under a music track.",
      "Do not add text, logos, extra people, extra limbs, or scene cuts."
    ].join(" ");

    job.status = "generating";
    job.message = "Wan 2.2 está generando el clip. Puede tardar varios minutos…";
    const clip = await makeWanClip(imageFile, prompt, options.clipDuration);
    const clipPath = path.join(work, "clip.mp4");
    await fs.writeFile(clipPath, clip);

    let finalPath = clipPath;
    const fileName = randomUUID() + ".mp4";
    if (audioFile) {
      job.status = "mixing";
      job.message = "El clip está listo. Ahora estamos uniendo la canción completa…";
      const ext = ({ "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/aac": "aac", "audio/flac": "flac", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/ogg": "ogg", "audio/webm": "webm", "audio/opus": "opus" })[audioFile.mimetype] || "audio";
      const audioPath = path.join(work, "music." + ext);
      finalPath = path.join(work, "final.mp4");
      await fs.writeFile(audioPath, audioFile.buffer);
      await runFfmpeg(["-y", "-stream_loop", "-1", "-i", clipPath, "-i", audioPath, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-preset", "veryfast", "-crf", "25", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", finalPath]);
    }
    const outputPath = path.join(OUTPUT_DIR, fileName);
    await fs.copyFile(finalPath, outputPath);
    const stat = await fs.stat(outputPath);
    job.status = "completed";
    job.videoUrl = "/generated/" + fileName;
    job.sizeBytes = stat.size;
    job.message = audioFile
      ? "Video terminado con la canción completa. El clip de baile se repite para cubrir la duración del audio."
      : "Clip generado. Sube una canción para crear el videoclip con audio.";
  } catch (error) {
    job.status = "failed";
    job.error = String(error?.message || error).slice(0, 700);
    job.message = "No se pudo terminar la generación.";
    console.error("DJ_SEBAS_GENERATION_ERROR", job.id, job.error);
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

app.post("/api/generate", upload.fields([{ name: "image", maxCount: 1 }, { name: "audio", maxCount: 1 }]), async (req, res) => {
  const imageFile = req.files?.image?.[0];
  const audioFile = req.files?.audio?.[0];
  if (!imageFile) return res.status(400).json({ error: "Selecciona una fotografía primero." });
  if (!ffmpegPath) return res.status(503).json({ error: "El servidor no tiene FFmpeg disponible para unir la canción y el video." });

  const requested = Number.parseFloat(req.body.duration || "4.5");
  const clipDuration = Math.max(1, Math.min(4.5, Number.isFinite(requested) ? requested : 4.5));
  const job = {
    id: randomUUID(), status: "queued",
    message: "Solicitud recibida. Preparando el trabajo…",
    createdAt: Date.now()
  };
  jobs.set(job.id, job);
  if (jobs.size > 30) {
    for (const [id, item] of jobs) {
      if (Date.now() - item.createdAt > 60 * 60 * 1000) jobs.delete(id);
    }
  }
  res.status(202).json({ ok: true, jobId: job.id, statusUrl: "/api/jobs/" + job.id });
  void runGenerationJob(job, imageFile, audioFile, {
    style: String(req.body.style || "Libre").slice(0, 80),
    userPrompt: String(req.body.prompt || "").slice(0, 1200),
    clipDuration
  });
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "No encuentro esta generación. Si el servidor se reinició, vuelve a iniciar el proceso." });
  res.setHeader("Cache-Control", "no-store");
  res.json({
    ok: job.status !== "failed",
    jobId: job.id,
    status: job.status,
    message: job.message,
    error: job.error || null,
    videoUrl: job.videoUrl || null,
    sizeBytes: job.sizeBytes || null
  });
});

app.use((err, _req, res, _next) => {
  console.error("REQUEST_ERROR", String(err?.message || err));
  res.status(err?.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
    error: err?.code === "LIMIT_FILE_SIZE"
      ? "La fotografía o canción supera 25 MB. Reduce el tamaño del archivo."
      : err.message || "No se pudo procesar la solicitud."
  });
});

const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => console.log("DJ SEBAS AI VIDEO listo · Wan 2.2 sin claves API + FFmpeg · puerto " + port));
