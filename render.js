import express from "express";
import cors from "cors";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAGIC_HOUR_API = "https://api.magichour.ai";
const OPENAI_MODEL = "gpt-6-astra";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const imageTypes = ["image/jpeg", "image/png", "image/webp"];
    const audioTypes = ["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/aac", "audio/flac", "audio/mp4", "audio/x-m4a", "audio/ogg", "audio/webm", "audio/opus", "audio/aiff"];
    if (file.fieldname === "image" && !imageTypes.includes(file.mimetype)) return cb(new Error("Formato de imagen no válido. Usa JPG, PNG o WEBP."));
    if (file.fieldname === "audio" && !audioTypes.includes(file.mimetype)) return cb(new Error("Formato de música no válido. Usa MP3, WAV, M4A, AAC, FLAC u OGG."));
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
    openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
    openaiModel: OPENAI_MODEL,
    videoEngineConfigured: Boolean(process.env.MAGIC_HOUR_API_KEY),
    engine: "OpenAI · " + OPENAI_MODEL + " / Magic Hour · LTX-2.5",
    note: process.env.OPENAI_API_KEY
      ? "OpenAI está configurado para analizar la fotografía y preparar el prompt."
      : "Falta OPENAI_API_KEY en Render. La clave debe guardarse como variable de entorno."
  });
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.post("/api/generate", upload.fields([{ name: "image", maxCount: 1 }, { name: "audio", maxCount: 1 }]), async (req, res) => {
  const imageFile = req.files?.image?.[0];
  const audioFile = req.files?.audio?.[0];
  if (!imageFile) return res.status(400).json({ error: "Selecciona una fotografía primero." });
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) return res.status(503).json({ error: "Falta configurar OPENAI_API_KEY en Render. Agrega tu clave como variable de entorno." });
  const apiKey = process.env.MAGIC_HOUR_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "OpenAI está configurado, pero falta la clave del motor de video Magic Hour. GPT prepara las instrucciones; no crea el archivo de video por sí solo." });

  const promptText = String(req.body.prompt || "").trim();
  const style = String(req.body.style || "Libre").trim();
  const duration = Math.min(60, Math.max(1, Number.parseInt(req.body.duration || "5", 10) || 5));
  const headers = { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "Content-Type": "application/json" };

  try {
    // OpenAI analiza la foto y prepara el prompt visual para el motor de video.
    const imageData = `data:${imageFile.mimetype};base64,${imageFile.buffer.toString("base64")}`;
    const aiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${openaiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        max_output_tokens: 280,
        input: [{
          role: "user",
          content: [
            { type: "input_text", text: `Eres director creativo de videoclips para DJ SEBAS AI VIDEO. Observa la fotografía y redacta un prompt visual en español para un motor image-to-video. Idea del usuario: ${promptText || "anima a la persona con movimientos naturales y fluidos"}. Estilo musical: ${style}. Duración: ${duration} segundos. ${audioFile ? "La canción se enviará al motor como guía de audio; crea movimientos de baile con acentos rítmicos." : "No hay canción cargada; crea movimientos naturales según el estilo indicado."} Describe movimientos realistas, cámara y ambiente; conserva rostro, ropa, identidad visual y número de personas. No inventes personas ni cambies su apariencia. Devuelve solamente el prompt final.` },
            { type: "input_image", image_url: imageData }
          ]
        }]
      }),
      signal: AbortSignal.timeout(60000)
    });
    const aiData = await aiResponse.json().catch(() => ({}));
    if (!aiResponse.ok) {
      const detail = aiData.error?.message || `OpenAI respondió HTTP ${aiResponse.status}`;
      const status = aiResponse.status === 401 ? 401 : aiResponse.status === 429 ? 429 : 502;
      return res.status(status).json({ error: `Error de OpenAI: ${detail}` });
    }
    const prompt = aiData.output_text || (aiData.output || [])
      .flatMap(item => item.content || [])
      .filter(part => part.type === "output_text")
      .map(part => part.text)
      .join("\n");
    if (!prompt) throw new Error("OpenAI no devolvió las instrucciones para el video.");

    const imageExt = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
    const audioExt = { "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/aac": "aac", "audio/flac": "flac", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/ogg": "ogg", "audio/webm": "webm", "audio/opus": "opus", "audio/aiff": "aiff" };
    if (!imageExt[imageFile.mimetype]) return res.status(400).json({ error: "Formato de imagen no válido." });
    if (audioFile && !audioExt[audioFile.mimetype]) return res.status(400).json({ error: "Formato de música no compatible." });
    const items = [{ type: "image", extension: imageExt[imageFile.mimetype] }];
    if (audioFile) items.push({ type: "audio", extension: audioExt[audioFile.mimetype] });
    const uploadResponse = await fetch(MAGIC_HOUR_API + "/v1/files/upload-urls", { method: "POST", headers, body: JSON.stringify({ items }), signal: AbortSignal.timeout(30000) });
    const uploadData = await uploadResponse.json().catch(() => ({}));
    if (!uploadResponse.ok || !uploadData.items?.[0]?.upload_url || !uploadData.items?.[0]?.file_path) throw new Error(uploadData.message || uploadData.error || "No se pudo preparar la carga en Magic Hour.");
    const imageAsset = uploadData.items[0];
    const imagePut = await fetch(imageAsset.upload_url, { method: "PUT", headers: { "Content-Type": imageFile.mimetype }, body: imageFile.buffer, signal: AbortSignal.timeout(60000) });
    if (!imagePut.ok) throw new Error("No se pudo subir la imagen a Magic Hour (HTTP " + imagePut.status + ").");
    let created;
    if (audioFile) {
      const audioAsset = uploadData.items[1];
      if (!audioAsset?.upload_url || !audioAsset?.file_path) throw new Error("Magic Hour no devolvió el espacio para subir la canción.");
      const audioPut = await fetch(audioAsset.upload_url, { method: "PUT", headers: { "Content-Type": audioFile.mimetype }, body: audioFile.buffer, signal: AbortSignal.timeout(120000) });
      if (!audioPut.ok) throw new Error("No se pudo subir la canción a Magic Hour (HTTP " + audioPut.status + ").");
      const createResponse = await fetch(MAGIC_HOUR_API + "/v1/audio-to-video", {
        method: "POST", headers,
        body: JSON.stringify({ name: "DJ SEBAS AI VIDEO con música", start_seconds: 0, end_seconds: duration, resolution: "480p", style: { prompt: prompt + " Genera visuales y movimientos de baile que reaccionen a la música cargada y acompasen la energía visual al ritmo. La sincronía es generativa y no garantiza coreografía exacta." }, assets: { audio_file_path: audioAsset.file_path, image_file_path: imageAsset.file_path } }),
        signal: AbortSignal.timeout(60000)
      });
      created = await createResponse.json().catch(() => ({}));
      if (!createResponse.ok || !created.id) { const message = created.message || created.error || "Magic Hour respondió HTTP " + createResponse.status; return res.status(createResponse.status === 402 ? 402 : createResponse.status === 401 ? 401 : 502).json({ error: message }); }
    } else {
      const createResponse = await fetch(MAGIC_HOUR_API + "/v1/image-to-video", { method: "POST", headers, body: JSON.stringify({ name: "DJ SEBAS AI VIDEO", end_seconds: duration, model: "ltx-2.5", resolution: "480p", audio: true, style: { prompt }, assets: { image_file_path: imageAsset.file_path } }), signal: AbortSignal.timeout(60000) });
      created = await createResponse.json().catch(() => ({}));
      if (!createResponse.ok || !created.id) { const message = created.message || created.error || "Magic Hour respondió HTTP " + createResponse.status; return res.status(createResponse.status === 402 ? 402 : createResponse.status === 401 ? 401 : 502).json({ error: message }); }
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
    console.error("DJ SEBAS generation error:", detail);
    if (!res.headersSent) return res.status(502).json({ error: "No se pudo generar el video con Magic Hour: " + detail.slice(0, 260) });
    res.end();
  }
});

app.use((err, _req, res, _next) => {
  console.error("REQUEST_ERROR", String(err?.message || err));
  res.status(err?.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
    error: err?.code === "LIMIT_FILE_SIZE"
      ? "El archivo supera el máximo de 25 MB. Usa una imagen o canción más ligera."
      : err.message || "No se pudo procesar la solicitud."
  });
});

const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => console.log(`DJ SEBAS AI VIDEO activo en puerto ${port}`));
