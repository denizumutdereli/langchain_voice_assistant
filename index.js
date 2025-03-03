import { PromptTemplate } from "@langchain/core/prompts";
import { ChatOpenAI } from "@langchain/openai";
import dotenv from "dotenv";
import express from "express";
import ffmpegStatic from "ffmpeg-static";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import http from "http";
import { ConversationChain } from "langchain/chains";
import { BufferMemory } from "langchain/memory";
import multer from "multer";
import OpenAI from "openai";
import path, { dirname } from "path";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import winston from "winston";
import { z } from "zod";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const envSchema = z.object({
  OPENAI_API_KEY: z.string().min(1, "OpenAI API key is required"),
  PORT: z.string().optional().default("3000"),
});

try {
  var env = envSchema.parse(process.env);
} catch (error) {
  console.error("Environment validation failed:", error.message);
  process.exit(1);
}

const logger = winston.createLogger({
  level: process.env.NODE_ENV === "production" ? "info" : "debug",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.colorize(),
    winston.format.printf(({ level, message, timestamp, ...meta }) => {
      return `${timestamp} ${level}: ${message} ${
        Object.keys(meta).length ? JSON.stringify(meta, null, 2) : ""
      }`;
    })
  ),
  transports: [
    new winston.transports.File({ filename: "error.log", level: "error" }),
    new winston.transports.File({ filename: "combined.log" }),
    new winston.transports.Console(),
  ],
});

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const port = parseInt(env.PORT, 10);
app.use(express.json());
app.use(express.static("public"));

const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
  logger.info(`Created upload directory: ${uploadDir}`);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    let fileName = `${Date.now()}-${file.originalname}`;
    if (!fileName.match(/\.(mp3|wav|m4a|ogg|webm)$/i)) fileName += ".mp3";
    cb(null, fileName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("audio/")) cb(null, true);
    else cb(new Error("Only audio files are allowed"));
  },
});

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

const textModel = new ChatOpenAI({
  openAIApiKey: env.OPENAI_API_KEY,
  temperature: 0.7,
  modelName: "gpt-4o",
});

const memory = new BufferMemory({
  returnMessages: true,
  memoryKey: "history",
  inputKey: "input",
  outputKey: "response",
  maxMessages: 10,
});

const conversationChain = new ConversationChain({
  llm: textModel,
  memory,
  prompt: PromptTemplate.fromTemplate(`
    You are a helpful, friendly assistant that provides clear and concise answers.
    Be conversational and engaging while maintaining accuracy and helpfulness.
    If unsure, admit it rather than guessing.
    Current conversation: {history}
    Human: {input}
    AI:`),
});

if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic);
  logger.info("FFmpeg path set successfully");
} else {
  logger.warn("FFmpeg not found, using system FFmpeg if available");
}

async function convertToMp3(inputPath) {
  const outputPath = `${inputPath}.mp3`;
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .toFormat("mp3")
      .on("start", (cmd) => logger.debug("FFmpeg started", { cmd }))
      .on("progress", (progress) => logger.debug("FFmpeg progress", { percent: progress.percent }))
      .on("end", () => {
        logger.info("Audio converted", { input: inputPath, output: outputPath });
        resolve(outputPath);
      })
      .on("error", (err) => {
        logger.error("Audio conversion failed", { error: err.message });
        reject(err);
      })
      .save(outputPath);
  });
}

async function renameToSupportedFormat(inputPath) {
  const outputPath = `${inputPath}.mp3`;
  fs.copyFileSync(inputPath, outputPath);
  logger.info("Audio renamed", { input: inputPath, output: outputPath });
  return outputPath;
}

io.on("connection", (socket) => {
  logger.info("Client connected", { socketId: socket.id });
  socket.on("stop-speech", () => {
    logger.info("Stop speech requested", { socketId: socket.id });
    socket.broadcast.emit("speech-stopped");
  });
  socket.on("disconnect", () => logger.info("Client disconnected", { socketId: socket.id }));
});

app.post("/api/text-query", async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: "Missing query parameter" });
    logger.info("Processing text query", { query: query.substring(0, 100) });
    const response = await conversationChain.call({ input: query });
    logger.info("Text response generated", { preview: response.response.substring(0, 100) });
    return res.json({ response: response.response, type: "text" });
  } catch (error) {
    logger.error("Text query error", { error: error.message });
    return res.status(500).json({ error: "Failed to process query", details: error.message });
  }
});

app.post("/api/test-transcription", upload.single("audio"), async (req, res) => {
  let convertedFilePath = null;
  try {
    if (!req.file) return res.status(400).json({ error: "No audio file uploaded" });
    logger.info("Testing transcription", { filename: req.file.originalname });
    convertedFilePath = req.file.path;
    if (!convertedFilePath.match(/\.(mp3|wav|m4a)$/i)) {
      convertedFilePath = ffmpegStatic ? await convertToMp3(req.file.path) : await renameToSupportedFormat(req.file.path);
    }
    io.emit("speech-progress", { status: "transcribing" });
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(convertedFilePath),
      model: "whisper-1",
      language: req.body.language !== "auto" ? req.body.language : undefined,
    });
    if (convertedFilePath !== req.file.path && fs.existsSync(convertedFilePath)) fs.unlinkSync(convertedFilePath);
    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    return res.json({ success: true, transcription: transcription.text });
  } catch (error) {
    logger.error("Transcription test error", { error: error.message });
    if (convertedFilePath && fs.existsSync(convertedFilePath)) fs.unlinkSync(convertedFilePath);
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    return res.status(500).json({ error: "Transcription failed", details: error.message });
  }
});

app.post("/api/voice-query", upload.single("audio"), async (req, res) => {
  let convertedFilePath = null;
  try {
    if (!req.file) return res.status(400).json({ error: "No audio file uploaded" });
    logger.info("Processing voice query", { filename: req.file.originalname });
    convertedFilePath = req.file.path;
    if (!convertedFilePath.match(/\.(mp3|wav|m4a)$/i)) {
      convertedFilePath = ffmpegStatic ? await convertToMp3(req.file.path) : await renameToSupportedFormat(req.file.path);
    }
    io.emit("speech-progress", { status: "transcribing" });
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(convertedFilePath),
      model: "whisper-1",
      language: req.body.language !== "auto" ? req.body.language : undefined,
    });
    io.emit("speech-progress", { status: "generating response" });
    const response = await conversationChain.call({ input: transcription.text });
    io.emit("speech-progress", { status: "generating speech" });
    const voice = req.body.voice || "alloy";
    const speechFile = path.join(__dirname, "uploads", `response-${Date.now()}.mp3`);
    const mp3 = await openai.audio.speech.create({
      model: "tts-1",
      voice,
      input: response.response,
    });
    const buffer = Buffer.from(await mp3.arrayBuffer());
    fs.writeFileSync(speechFile, buffer);
    if (convertedFilePath !== req.file.path && fs.existsSync(convertedFilePath)) fs.unlinkSync(convertedFilePath);
    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    io.emit("speech-ready", { audioUrl: `/download/${path.basename(speechFile)}` });
    return res.json({
      response: response.response,
      transcription: transcription.text,
      audioUrl: `/download/${path.basename(speechFile)}`,
      type: "voice",
    });
  } catch (error) {
    logger.error("Voice query error", { error: error.message });
    if (convertedFilePath && fs.existsSync(convertedFilePath)) fs.unlinkSync(convertedFilePath);
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    return res.status(500).json({ error: "Failed to process voice query", details: error.message });
  }
});

app.post("/api/clear-memory", async (req, res) => {
  try {
    await memory.clear();
    logger.info("Conversation memory cleared");
    return res.json({ success: true });
  } catch (error) {
    logger.error("Clear memory error", { error: error.message });
    return res.status(500).json({ error: "Failed to clear memory" });
  }
});

app.get("/download/:filename", (req, res) => {
  const filePath = path.join(__dirname, "uploads", req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Audio file not found" });
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Content-Disposition", `attachment; filename="${req.params.filename}"`);
  const fileStream = fs.createReadStream(filePath);
  fileStream.pipe(res);
  res.on("finish", () => {
    fs.unlinkSync(filePath);
    logger.info("Audio file deleted", { file: req.params.filename });
  });
  fileStream.on("error", (err) => {
    logger.error("Stream error", { error: err.message });
    if (!res.headersSent) res.status(500).json({ error: "Failed to stream file" });
  });
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/health", (req, res) => res.status(200).json({ status: "ok", uptime: process.uptime() }));

app.use((err, req, res, next) => {
  logger.error("Unhandled error", { error: err.message });
  res.status(500).json({ error: "Internal server error" });
});

server.listen(port, () => {
  logger.info(`Server running on http://localhost:${port}`);
});

process.on("SIGINT", () => {
  logger.info("Shutting down server");
  server.close(() => process.exit(0));
});

const publicDir = path.join(__dirname, "public");
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
  logger.info(`Created public directory: ${publicDir}`);
}