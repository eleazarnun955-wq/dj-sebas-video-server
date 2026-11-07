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
const OPENAI_MODEL = "gpt-5.4-mini";
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
  openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
  videoEngineConfigured: true,
  engine: "GPT + Wan 2.2 público",
  audioMixing: Boolean(ffmpegPath),
  note: "GPT prepara las instrucciones; Wan genera un clip corto y FFmpeg lo combina con la canción."
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
  const data = [
    inputImage, null, prompt, 6,
    "色调艳丽, 过曝, 静态, 细节模糊不清, 字幕, 风格, 作品, 画作, 画面, 静止, 整体发灰, 最差质量, 低质量, JPEG压缩残留, 丑陋的, 残缺的, 多余的手指, 画得不好的手部, 画得不好的脸部, 畸形的, 毁容的, 形态畸形的肢体, 手指融合, 静止不动的画面, 杂乱的背景, 三条腿, 背景人很多, 倒着走",
    duration, 1, 1, 42, true, 6, "UniPCMultistep", 3.0, 16, false, true
  ];
  const start = await fetch(HF_SPACE + "/gradio_api/call/generate_video", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data }), signal: AbortSignal.timeout(60000)
  });
  if (!start.ok) throw new Error("Wan 2.2 rechazó la generación (HTTP " + start.status + "). Puede estar saturado o sin cuota disponible.");
  const created = await start.json();
  if (!created.event_id) throw new Error("Wan 2.2 no devolvió el identificador de generación.");
  const result = await fetch(HF_SPACE + "/gradio_api/call/generate_video/" + encodeURIComponent(created.event_id), {
    headers: { Accept: "text/event-stream" }, signal: AbortSignal.timeout(10 * 60 * 1000)
  });
  if (!result.ok || !result.body) throw new Error("No se pudo consultar el resultado de Wan 2.2 (HTTP " + result.status + ").");
  const body = await result.text();
  const blocks = body.split("\n\n");
  for (const block of blocks) {
    const event = block.match(/^event:\s*(\S+)/m)?.[1];
    const raw = block.split("\n").filter(x => x.startsWith("data:")).map(x => x.slice(5).trim()).join("\n");
    if (event === "error") throw new Error("Wan 2.2: " + (raw || "el motor no pudo generar el clip."));
    if (event === "complete") {
      let payload;
      try { payload = JSON.parse(raw); } catch { throw new Error("Wan 2.2 devolvió un resultado ilegible."); }
      const url = getVideoPath(payload);
      if (!url) throw new Error("Wan 2.2 terminó pero no entregó un archivo de video.");
      const videoResponse = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (!videoResponse.ok) throw new Error("No se pudo descargar el clip generado (HTTP " + videoResponse.status + ").");
      return Buffer.from(await videoResponse.arrayBuffer());
    }
  }
  throw new Error("Wan 2.2 cerró la conexión antes de entregar el video.");
}

app.post("/api/generate", upload.fields([{ name: "image", maxCount: 1 }, { name: "audio", maxCount: 1 }]), async (req, res) => {
  const imageFile = req.files?.image?.[0];
  const audioFile = req.files?.audio?.[0];
  if (!imageFile) return res.status(400).json({ error: "Selecciona una fotografía primero." });
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: "Falta OPENAI_API_KEY en las variables de Render. No pegues la clave aquí en el chat." });
  if (!ffmpegPath) return res.status(503).json({ error: "El servidor no tiene FFmpeg disponible para unir la canción y el video." });

  const style = String(req.body.style || "Libre").slice(0, 80);
  const userPrompt = String(req.body.prompt || "").slice(0, 1200);
  const requested = Number.parseFloat(req.body.duration || "4.5");
  const clipDuration = Math.max(1, Math.min(4.5, Number.isFinite(requested) ? requested : 4.5));
  const work = path.join(os.tmpdir(), "dj-sebas-" + randomUUID());
  await fs.mkdir(work, { recursive: true });

  try {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.write("Preparando instrucciones con GPT…\n");

    const imageData = "data:" + imageFile.mimetype + ";base64," + imageFile.buffer.toString("base64");
    const ai = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: "Bearer " + process.env.OPENAI_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OPENAI_MODEL, max_output_tokens: 350,
        input: [{ role: "user", content: [
          { type: "input_text", text: "Eres director de movimiento de DJ SEBAS AI VIDEO. Analiza la fotografía y crea un prompt para un clip image-to-video de " + clipDuration + " segundos, que pueda repetirse en bucle sin salto brusco. Estilo: " + style + ". Instrucción del usuario: " + (userPrompt || "persona bailando con energía y movimientos naturales") + ". " +
          "Conserva la identidad, cara, ropa y número de personas. Describe pasos de baile rítmicos, movimiento corporal natural, cámara estable y fondo. No afirmes que escuchaste la canción; la sincronización final se hará al montar el clip con el audio. Devuelve solo el prompt visual." },
          { type: "input_image", image_url: imageData, detail: "high" }
        ] }]
      }),
      signal: AbortSignal.timeout(60000)
    });
    const aiData = await ai.json().catch(() => ({}));
    if (!ai.ok) throw new Error("OpenAI respondió HTTP " + ai.status + ": " + (aiData.error?.message || "no se pudo preparar el prompt."));
    const prompt = getOutputText(aiData).trim();
    if (!prompt) throw new Error("GPT no devolvió instrucciones de movimiento.");

    res.write("GPT preparó el movimiento. Wan 2.2 está generando el clip…\n");
    const clip = await makeWanClip(imageFile, prompt, clipDuration);
    const clipPath = path.join(work, "clip.mp4");
    await fs.writeFile(clipPath, clip);

    let finalPath = clipPath;
    let fileName = randomUUID() + ".mp4";
    if (audioFile) {
      res.write("Clip generado. Combinando la canción completa con el video…\n");
      const ext = ({ "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/aac": "aac", "audio/flac": "flac", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/ogg": "ogg", "audio/webm": "webm", "audio/opus": "opus" })[audioFile.mimetype] || "audio";
      const audioPath = path.join(work, "music." + ext);
      finalPath = path.join(work, "final.mp4");
      await fs.writeFile(audioPath, audioFile.buffer);
      await runFfmpeg(["-y", "-stream_loop", "-1", "-i", clipPath, "-i", audioPath, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-preset", "veryfast", "-crf", "25", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", finalPath]);
    }
    const outputPath = path.join(OUTPUT_DIR, fileName);
    await fs.copyFile(finalPath, outputPath);
    const stat = await fs.stat(outputPath);
    res.end(JSON.stringify({
      ok: true, videoUrl: "/generated/" + fileName,
      duration: audioFile ? "Duración de la canción" : "Clip corto",
      audioIncluded: Boolean(audioFile), repeatedClip: Boolean(audioFile),
      sizeBytes: stat.size,
      message: audioFile
        ? "Video terminado con la canción completa. El clip de baile se repite para cubrir la duración del audio."
        : "Clip generado. Sube una canción para crear el videoclip con audio."
    }));
  } catch (error) {
    const detail = String(error?.message || error);
    console.error("DJ_SEBAS_GENERATION_ERROR", detail);
    if (!res.headersSent) return res.status(502).json({ error: detail.slice(0, 700) });
    res.end(JSON.stringify({ ok: false, error: detail.slice(0, 700) }));
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
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
app.listen(port, "0.0.0.0", () => console.log("DJ SEBAS AI VIDEO listo · GPT + Wan 2.2 + FFmpeg · puerto " + port));
