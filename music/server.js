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
import { Client } from "@gradio/client";

const app = express();
const root = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(os.tmpdir(), "dj-sebas-music-output");
await fs.mkdir(outDir, { recursive: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 40 * 1024 * 1024, files: 2 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["audio/mpeg","audio/mp3","audio/wav","audio/x-wav","audio/aac","audio/flac","audio/mp4","audio/x-m4a","audio/ogg","audio/webm","audio/opus"];
    if (!allowed.includes(file.mimetype)) return cb(new Error("Formato no compatible. Usa MP3, WAV, M4A, AAC, FLAC u OGG."));
    cb(null, true);
  }
});

app.use(cors());
app.use(express.static(path.join(root, "public")));
app.use("/downloads", express.static(outDir, { fallthrough: false, maxAge: "1h" }));

const ACE_STEP_SPACE = "https://ace-step-ace-step-v1-5.hf.space";

app.get("/api/status", (_req, res) => res.json({
  status: "online",
  app: "DJ SEBAS AI MUSIC",
  engine: "ACE-Step 1.5 (Hugging Face Space)",
  engineUrl: "https://huggingface.co/spaces/ACE-Step/Ace-Step-v1.5",
  audioTools: Boolean(ffmpegPath),
  generationMode: "Official hosted interface; Hugging Face ZeroGPU limits apply"
}));

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error("FFmpeg no está disponible en el servidor."));
    const child = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", chunk => { err += chunk.toString(); if (err.length > 8000) err = err.slice(-8000); });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error("No se pudo procesar el audio: " + err.slice(-700))));
  });
}

const extFor = mime => ({
  "audio/mpeg":"mp3","audio/mp3":"mp3","audio/wav":"wav","audio/x-wav":"wav",
  "audio/aac":"aac","audio/flac":"flac","audio/mp4":"m4a","audio/x-m4a":"m4a",
  "audio/ogg":"ogg","audio/webm":"webm","audio/opus":"opus"
}[mime] || "audio");

app.post("/api/mashup", upload.fields([{name:"trackA",maxCount:1},{name:"trackB",maxCount:1}]), async (req,res) => {
  const a=req.files?.trackA?.[0], b=req.files?.trackB?.[0];
  if(!a || !b) return res.status(400).json({error:"Selecciona dos canciones para crear el mashup."});
  const job=randomUUID(), work=path.join(os.tmpdir(),"dj-sebas-mix-"+job);
  await fs.mkdir(work,{recursive:true});
  try {
    const pa=path.join(work,"a."+extFor(a.mimetype)), pb=path.join(work,"b."+extFor(b.mimetype));
    const dest=path.join(outDir,job+".mp3");
    await Promise.all([fs.writeFile(pa,a.buffer),fs.writeFile(pb,b.buffer)]);
    const mode=req.body.mode==="sequential"?"sequential":"overlay";
    if(mode==="sequential") {
      await runFfmpeg(["-y","-i",pa,"-i",pb,"-filter_complex","[0:a]aresample=44100,asetpts=PTS-STARTPTS[a0];[1:a]aresample=44100,asetpts=PTS-STARTPTS[a1];[a0][a1]concat=n=2:v=0:a=1, loudnorm=I=-16:TP=-1.5:LRA=11[out]","-map","[out]","-codec:a","libmp3lame","-b:a","192k",dest]);
    } else {
      const blendValue=Number(req.body.blend); const blend=Number.isFinite(blendValue)?Math.max(0,Math.min(1,blendValue)):0.5;
      await runFfmpeg(["-y","-i",pa,"-i",pb,"-filter_complex",`[0:a]volume=${(1-blend).toFixed(2)},aresample=44100[a0];[1:a]volume=${blend.toFixed(2)},aresample=44100[a1];[a0][a1]amix=inputs=2:duration=longest:dropout_transition=3:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11[out]`,"-map","[out]","-codec:a","libmp3lame","-b:a","192k",dest]);
    }
    res.json({ok:true,url:"/downloads/"+job+".mp3",filename:"DJ-SEBAS-MASHUP.mp3",mode});
  } catch(e) {
    res.status(500).json({error:e.message||"Error al crear el mashup."});
  } finally {
    await fs.rm(work,{recursive:true,force:true}).catch(()=>{});
  }
});


const ACE_STEP_SOURCE = "ACE-Step/Ace-Step-v1.5";
let aceClientPromise;
const generationJobs = new Map();

async function getAceClient() {
  if (!aceClientPromise) {
    aceClientPromise = Client.connect(ACE_STEP_SOURCE, { events: ["status", "data"] });
    aceClientPromise.catch(() => { aceClientPromise = null; });
  }
  return aceClientPromise;
}

function fallbackForType(type) {
  const t = String(type || "").toLowerCase();
  if (t.includes("boolean")) return false;
  if (t.includes("number") || t.includes("integer")) return 0;
  if (t.includes("array")) return [];
  return null;
}

function buildAcePayload(client, endpointName, overrides = {}) {
  const apiInfo = client.__aceApiInfo;
  const endpoint = apiInfo?.named_endpoints?.[endpointName];
  if (!endpoint) throw new Error("ACE-Step no publicó el endpoint " + endpointName);
  const config = client.config || {};
  const dependencies = config.dependencies || [];
  const normalizedName = endpointName.replace(/^\//, "");
  const dependency = dependencies.find(d => String(d.api_name || "").replace(/^\//, "") === normalizedName);
  const componentMap = new Map((config.components || []).map(c => [c.id, c]));
  let visibleInputs = [];
  if (dependency) {
    visibleInputs = (dependency.inputs || [])
      .map(id => componentMap.get(id))
      .filter(c => c && String(c.type || "").toLowerCase() !== "state");
  }

  const payload = {};
  endpoint.parameters.forEach((parameter, index) => {
    const component = visibleInputs[index];
    const props = component?.props || {};
    let value = Object.prototype.hasOwnProperty.call(props, "value")
      ? props.value
      : fallbackForType(parameter.type);
    if (value && typeof value === "object" && value.__type__ === "update") value = null;
    const label = String(parameter.label || props.label || "").trim().toLowerCase();
    const name = String(parameter.parameter_name || "").trim();
    let override;
    if (Object.prototype.hasOwnProperty.call(overrides, name)) override = overrides[name];
    else if (Object.prototype.hasOwnProperty.call(overrides, label)) override = overrides[label];
    else if (Object.prototype.hasOwnProperty.call(overrides, label.replace(/\s+/g, "_"))) override = overrides[label.replace(/\s+/g, "_")];
    payload[name] = override === undefined ? value : override;
  });
  return payload;
}

function collectAudioCandidates(value, found = [], depth = 0) {
  if (depth > 8 || value == null) return found;
  const audioPattern = /\.(mp3|wav|flac|ogg|m4a|aac|opus)(?:[?#].*)?$/i;
  if (typeof value === "string") {
    if (audioPattern.test(value) || value.includes("/gradio_api/file=") || value.includes("/file=")) {
      found.push({ url: value });
    }
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectAudioCandidates(item, found, depth + 1);
    return found;
  }
  if (typeof value === "object") {
    const url = value.url || value.audio_url || value.download_url;
    const pathValue = value.path || value.file;
    const mime = String(value.mime_type || value.mimeType || "");
    const name = String(value.orig_name || value.name || "");
    if (typeof url === "string" && (mime.startsWith("audio/") || audioPattern.test(url) || audioPattern.test(name) || url.includes("/file="))) {
      found.push({ url, name, mime });
    } else if (typeof pathValue === "string" && audioPattern.test(pathValue)) {
      found.push({ url: pathValue, name, mime });
    }
    for (const [key, child] of Object.entries(value)) {
      if (!["url", "audio_url", "download_url", "path", "file"].includes(key)) {
        collectAudioCandidates(child, found, depth + 1);
      }
    }
  }
  return found;
}

async function runAceGeneration(job, input) {
  job.status = "connecting";
  job.message = "Conectando con ACE-Step 1.5…";
  const client = await getAceClient();
  const apiInfo = await client.view_api();
  client.__aceApiInfo = apiInfo;

  const language = input.language || "es";
  let caption = String(input.prompt || "").trim();
  let lyrics = String(input.lyrics || "").trim();
  let bpm = Number(input.bpm) || null;
  let duration = Math.min(600, Math.max(10, Number(input.duration) || 180));
  let keyScale = "";
  let timeSignature = "4/4";

  if (!lyrics && !input.instrumental && apiInfo.named_endpoints?.["/handle_create_sample_wrapper"]) {
    try {
      job.status = "writing";
      job.message = "La IA está creando la letra y los detalles musicales…";
      const samplePayload = buildAcePayload(client, "/handle_create_sample_wrapper", {
        query: caption,
        instrumental: false,
        vocal_lang: language,
        temp: 0.85,
        top_k: 50,
        top_p: 1,
        debug: false
      });
      const sample = await client.predict("/handle_create_sample_wrapper", samplePayload);
      const data = sample?.data || [];
      if (typeof data[0] === "string" && data[0].trim()) caption = data[0];
      if (typeof data[1] === "string" && data[1].trim()) lyrics = data[1];
      if (Number(data[2]) > 0) bpm = Number(data[2]);
      if (Number(data[3]) > 0) duration = Math.min(duration, Number(data[3]));
      if (typeof data[4] === "string") keyScale = data[4];
      if (typeof data[7] === "string") timeSignature = data[7];
    } catch (error) {
      job.message = "No se pudo autogenerar la letra; intentaré crear la canción con tu descripción.";
      console.log("[ACE-STEP SAMPLE FALLBACK]", error.message);
    }
  }

  if (input.instrumental && !/instrumental|sin voces|no vocals/i.test(caption)) {
    caption += " Instrumental, sin voces ni letra.";
  }
  const generationOverrides = {
    generation_mode: "custom",
    simple_query_input: "",
    simple_vocal_language: language,
    param_4: caption,
    param_5: input.instrumental ? "" : lyrics,
    param_6: bpm || 0,
    param_7: keyScale,
    param_8: timeSignature,
    param_9: language,
    param_10: 8,
    param_11: 7,
    param_12: true,
    param_13: "-1",
    param_15: duration,
    param_16: 1,
    param_23: "text2music",
    param_27: 3,
    param_28: "ode",
    param_29: "",
    param_30: "mp3",
    param_31: 0.85,
    param_32: true,
    param_33: 2,
    param_36: "NO USER INPUT",
    param_41: false,
    param_43: false,
    param_44: false
  };
  const payload = buildAcePayload(client, "/generation_wrapper", generationOverrides);
  if (apiInfo.named_endpoints?.["/generation_wrapper"]?.parameters?.length !== Object.keys(payload).length) {
    throw new Error("La interfaz de ACE-Step cambió y no se pudieron preparar los parámetros de generación.");
  }

  job.status = "queued";
  job.message = "Solicitud enviada a la cola gratuita de Hugging Face…";
  const submission = client.submit("/generation_wrapper", payload);
  let lastData = null;
  for await (const message of submission) {
    if (message.type === "status") {
      if (message.stage === "pending") job.status = "queued";
      else if (message.stage === "generating") job.status = "generating";
      job.message = message.message || (message.stage === "pending" ? "Esperando turno en Hugging Face…" : "Generando tu canción…");
      if (Number.isFinite(message.position)) job.queuePosition = message.position;
    } else if (message.type === "data") {
      lastData = message.data;
      job.status = "generating";
      job.message = "La IA está componiendo y renderizando el audio…";
    }
  }

  if (lastData == null) throw new Error("ACE-Step terminó sin devolver resultados de audio.");
  const candidates = collectAudioCandidates(lastData);
  const unique = [...new Map(candidates.map(item => [item.url, item])).values()];
  if (!unique.length) {
    console.log("[ACE-STEP NO AUDIO RESULT]", JSON.stringify(lastData).slice(0, 5000));
    throw new Error("ACE-Step respondió, pero no encontré el archivo de audio en el resultado.");
  }

  job.status = "downloading";
  job.message = "Descargando el audio generado…";
  const saved = [];
  for (const [index, item] of unique.slice(0, 4).entries()) {
    const url = new URL(item.url, ACE_STEP_SPACE).toString();
    const response = await fetch(url, { signal: AbortSignal.timeout(90000) });
    if (!response.ok) continue;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 1000) continue;
    const match = (item.name || item.url).match(/\.(mp3|wav|flac|ogg|m4a|aac|opus)(?:[?#].*)?$/i);
    const ext = match ? match[1].toLowerCase() : (item.mime?.includes("mpeg") ? "mp3" : "wav");
    const filename = "DJ-SEBAS-" + job.id + (index ? "-" + (index + 1) : "") + "." + ext;
    await fs.writeFile(path.join(outDir, filename), buffer);
    saved.push({ url: "/downloads/" + filename, filename, size: buffer.length });
  }
  if (!saved.length) throw new Error("No se pudo descargar el audio desde Hugging Face. Intenta nuevamente cuando el Space esté disponible.");
  job.status = "completed";
  job.message = "¡Tu canción está lista!";
  job.files = saved;
  job.caption = caption;
  job.lyrics = lyrics;
  job.duration = duration;
}

app.post("/api/generate", async (req, res) => {
  const prompt = String(req.body?.prompt || "").trim();
  const lyrics = String(req.body?.lyrics || "").trim();
  if (!prompt) return res.status(400).json({ error: "Escribe una descripción para tu canción." });
  if (prompt.length > 5000 || lyrics.length > 12000) return res.status(413).json({ error: "La descripción o la letra es demasiado larga." });
  const id = randomUUID();
  const job = { id, status: "queued", message: "Preparando solicitud…", createdAt: Date.now(), files: [] };
  generationJobs.set(id, job);
  const input = {
    prompt, lyrics,
    duration: req.body?.duration,
    language: String(req.body?.language || "es"),
    bpm: req.body?.bpm,
    instrumental: Boolean(req.body?.instrumental),
    title: String(req.body?.title || "DJ SEBAS AI MUSIC")
  };
  runAceGeneration(job, input).catch(error => {
    job.status = "error";
    job.message = error.message || "No se pudo generar la canción.";
    console.error("[ACE-STEP GENERATION ERROR]", error);
  });
  res.status(202).json({ ok: true, jobId: id, status: job.status });
});

app.get("/api/generate/:id", (req, res) => {
  const job = generationJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "No se encontró esta generación." });
  res.json({
    ok: job.status !== "error",
    jobId: job.id,
    status: job.status,
    message: job.message,
    queuePosition: job.queuePosition || null,
    files: job.files || [],
    caption: job.caption || "",
    lyrics: job.lyrics || "",
    duration: job.duration || null
  });
});

app.use((err,_req,res,_next)=>{
  res.status(err?.code==="LIMIT_FILE_SIZE"?413:400).json({error:err?.code==="LIMIT_FILE_SIZE"?"Cada canción debe pesar menos de 40 MB.":err.message||"No se pudo procesar la solicitud."});
});

const port=process.env.PORT||3000;
app.listen(port,"0.0.0.0",()=>{ console.log("DJ SEBAS AI MUSIC activo en puerto "+port); setTimeout(async()=>{ try { const client=await getAceClient(); const info=await client.view_api(); const endpoints=Object.keys(info.named_endpoints||{}); console.log("[ACE-STEP CLIENT READY]",JSON.stringify(endpoints.filter(x=>x.includes("generation_wrapper")||x.includes("create_sample")))); } catch(error) { console.log("[ACE-STEP CLIENT ERROR]",error.message); } },1500); });