import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function prepareAudioBufferForYandexStt(
  audioBuffer: Buffer,
  mimeType: string,
): Promise<{ audioBuffer: Buffer; format: "oggopus" }> {
  const normalizedMimeType = (mimeType || "").toLowerCase();
  if (
    normalizedMimeType.includes("ogg") ||
    normalizedMimeType.includes("opus") && normalizedMimeType.includes("ogg")
  ) {
    return { audioBuffer, format: "oggopus" };
  }
  if (normalizedMimeType.includes("webm") || normalizedMimeType.includes("matroska")) {
    const convertedBuffer = await convertAudioWithFfmpeg(audioBuffer, "webm", "ogg");
    return { audioBuffer: convertedBuffer, format: "oggopus" };
  }
  if (normalizedMimeType.includes("mpeg") || normalizedMimeType.includes("mp3")) {
    const convertedBuffer = await convertAudioWithFfmpeg(audioBuffer, "mp3", "ogg");
    return { audioBuffer: convertedBuffer, format: "oggopus" };
  }
  throw new Error(
    `Неподдерживаемый формат аудио (${mimeType || "unknown"}). Запишите через Chrome или установите ffmpeg на сервере.`,
  );
}

async function convertAudioWithFfmpeg(
  inputBuffer: Buffer,
  inputExtension: string,
  outputExtension: string,
): Promise<Buffer> {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "voice-stt-"));
  const inputPath = path.join(temporaryDirectory, `input.${inputExtension}`);
  const outputPath = path.join(temporaryDirectory, `output.${outputExtension}`);

  try {
    await fs.writeFile(inputPath, inputBuffer);
    await runFfmpegConversion(inputPath, outputPath);
    return await fs.readFile(outputPath);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function runFfmpegConversion(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpegProcess = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      inputPath,
      "-ac",
      "1",
      "-ar",
      "48000",
      "-c:a",
      "libopus",
      "-b:a",
      "64k",
      outputPath,
    ]);

    let stderrText = "";
    ffmpegProcess.stderr.on("data", (chunk: Buffer) => {
      stderrText += chunk.toString("utf8");
    });

    ffmpegProcess.on("error", (spawnError) => {
      reject(
        new Error(
          `ffmpeg недоступен (${spawnError.message}). Установите ffmpeg на VDS для WebM→OGG.`,
        ),
      );
    });

    ffmpegProcess.on("close", (exitCode) => {
      if (exitCode === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `ffmpeg завершился с кодом ${exitCode ?? "unknown"}: ${stderrText.trim() || "без вывода"}`,
        ),
      );
    });
  });
}

export function guessMimeTypeFromFilename(filename: string): string {
  const lowerName = filename.toLowerCase();
  if (lowerName.endsWith(".ogg")) {
    return "audio/ogg";
  }
  if (lowerName.endsWith(".webm")) {
    return "audio/webm";
  }
  if (lowerName.endsWith(".mp3")) {
    return "audio/mpeg";
  }
  return "application/octet-stream";
}
