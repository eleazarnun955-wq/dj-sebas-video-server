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
      const blend=Math.max(0,Math.min(1,Number(req.body.blend)||0.5));
      await runFfmpeg(["-y","-i",pa,"-i",pb,"-filter_complex",`[0:a]volume=${(1-blend).toFixed(2)},aresample=44100[a0];[1:a]volume=${blend.toFixed(2)},aresample=44100[a1];[a0][a1]amix=inputs=2:duration=longest:dropout_transition=3:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11[out]`,"-map","[out]","-codec:a","libmp3lame","-b:a","192k",dest]);
    }
    res.json({ok:true,url:"/downloads/"+job+".mp3",filename:"DJ-SEBAS-MASHUP.mp3",mode});
  } catch(e) {
    res.status(500).json({error:e.message||"Error al crear el mashup."});
  } finally {
    await fs.rm(work,{recursive:true,force:true}).catch(()=>{});
  }
});

app.use((err,_req,res,_next)=>{
  res.status(err?.code==="LIMIT_FILE_SIZE"?413:400).json({error:err?.code==="LIMIT_FILE_SIZE"?"Cada canción debe pesar menos de 40 MB.":err.message||"No se pudo procesar la solicitud."});
});

const port=process.env.PORT||3000;
app.listen(port,"0.0.0.0",()=>console.log("DJ SEBAS AI MUSIC activo en puerto "+port));