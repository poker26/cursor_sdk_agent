import type express from "express";
import type { SDKUserMessage } from "@cursor/sdk";
import { parseChatResponseMode, type ChatResponseMode } from "../chat-response-style.js";
import type { WorkspaceEntry } from "../workspace-registry.js";
import { guessMimeTypeFromFilename } from "./audio-convert.js";
import { isVoiceEnabled, loadYandexVoiceConfig } from "./config.js";
import { transcribeAudioWithYandex } from "./yandex-stt.js";
import { buildVoiceTurnErrorPayload } from "./voice-error-speech.js";

interface VoiceTurnRequestBody {
  message?: string;
  audioBase64?: string;
  mimeType?: string;
  filename?: string;
  sessionId?: string;
  workspaceId?: string;
  responseMode?: string;
  modelId?: string;
}

export interface ChatMessageRunResult {
  assistantText: string;
  runOutcome: { status: string; result?: string; runId: string };
}

export interface VoiceTurnRouteHost {
  normalizeSessionId: (rawSessionId: unknown) => string;
  resolveWorkspace: (rawWorkspaceId: unknown) => WorkspaceEntry;
  buildUserMessagePayload: (
    userMessageText: string,
    sessionId: string,
    workspacePath: string,
    attachments: [],
  ) => Promise<string | SDKUserMessage>;
  isSessionBusy: (sessionId: string) => boolean;
  isWorkspaceBusy: (workspaceId: string) => boolean;
  acquireChatTurnLocks: (
    sessionId: string,
    workspaceId: string,
    modelId: string,
  ) => Promise<void>;
  releaseChatTurnLocks: (sessionId: string, workspaceId: string) => void;
  resolveModelId: (
    response: express.Response,
    rawModelId: unknown,
  ) => Promise<string | undefined>;
  runChatTurnWithRetry: (
    workspace: WorkspaceEntry,
    sessionId: string,
    userMessagePayload: string | SDKUserMessage,
    userMessageText: string,
    responseMode: ChatResponseMode,
    modelId: string,
  ) => Promise<ChatMessageRunResult>;
  recoverWorkspaceAfterFailure: (
    workspaceId: string,
    reason: string,
    error: unknown,
  ) => Promise<void>;
}

function decodeBase64AudioPayload(audioBase64: string): Buffer {
  const normalizedBase64 = audioBase64.replace(/\s/g, "");
  return Buffer.from(normalizedBase64, "base64");
}

export function registerVoiceTurnRoute(
  application: express.Application,
  host: VoiceTurnRouteHost,
): void {
  application.post("/api/voice/turn", async (request, response) => {
    const turnStartedAtMs = Date.now();
    const requestBody = request.body as VoiceTurnRequestBody;
    const sessionId = host.normalizeSessionId(requestBody.sessionId);
    const workspace = host.resolveWorkspace(requestBody.workspaceId);
    const responseMode = parseChatResponseMode(requestBody.responseMode ?? "voice");
    const resolvedModelId = await host.resolveModelId(response, requestBody.modelId);
    if (!resolvedModelId) {
      return;
    }

    let userMessageText =
      typeof requestBody.message === "string" ? requestBody.message.trim() : "";

    const audioBase64 =
      typeof requestBody.audioBase64 === "string" ? requestBody.audioBase64.trim() : "";

    if (!userMessageText && audioBase64) {
      if (!isVoiceEnabled()) {
        response.status(503).json({
          ok: false,
          error: "Голос отключён: задайте YANDEX_API_KEY и YANDEX_FOLDER_ID.",
        });
        return;
      }

      let voiceConfig;
      try {
        voiceConfig = loadYandexVoiceConfig();
      } catch (configError) {
        response.status(503).json({
          ok: false,
          error: configError instanceof Error ? configError.message : String(configError),
        });
        return;
      }

      let audioBuffer: Buffer;
      try {
        audioBuffer = decodeBase64AudioPayload(audioBase64);
      } catch {
        response.status(400).json({ ok: false, error: "Некорректный audioBase64." });
        return;
      }

      if (audioBuffer.length > voiceConfig.maxAudioBytes) {
        response.status(400).json({
          ok: false,
          error: `Аудио слишком большое (макс. ${voiceConfig.maxAudioBytes} байт).`,
        });
        return;
      }

      const mimeType =
        typeof requestBody.mimeType === "string" && requestBody.mimeType.trim()
          ? requestBody.mimeType.trim()
          : guessMimeTypeFromFilename(
              typeof requestBody.filename === "string" ? requestBody.filename : "",
            );

      try {
        const sttResult = await transcribeAudioWithYandex(audioBuffer, mimeType);
        userMessageText = sttResult.text.trim();
      } catch (transcribeError) {
        response.status(502).json({
          ok: false,
          error:
            transcribeError instanceof Error
              ? transcribeError.message
              : String(transcribeError),
        });
        return;
      }
    }

    if (!userMessageText) {
      response.status(400).json({
        ok: false,
        error: "Нужен message или audioBase64 с распознаваемой речью.",
      });
      return;
    }

    if (host.isSessionBusy(sessionId)) {
      response.status(429).json({
        ok: false,
        error: "Этот диалог ещё обрабатывает предыдущее сообщение. Дождитесь ответа.",
        sessionId,
      });
      return;
    }

    if (host.isWorkspaceBusy(workspace.id)) {
      response.status(429).json({
        ok: false,
        error: "Агент workspace занят другим запросом. Дождитесь ответа.",
        workspaceId: workspace.id,
      });
      return;
    }

    let userMessagePayload: string | SDKUserMessage;
    try {
      userMessagePayload = await host.buildUserMessagePayload(
        userMessageText,
        sessionId,
        workspace.path,
        [],
      );
    } catch (buildError) {
      response.status(400).json({
        ok: false,
        error: buildError instanceof Error ? buildError.message : String(buildError),
      });
      return;
    }

    try {
      await host.acquireChatTurnLocks(sessionId, workspace.id, resolvedModelId);
    } catch (lockError) {
      response.status(503).json({
        ok: false,
        error: lockError instanceof Error ? lockError.message : String(lockError),
      });
      return;
    }

    try {
      const chatResult = await host.runChatTurnWithRetry(
        workspace,
        sessionId,
        userMessagePayload,
        userMessageText,
        responseMode,
        resolvedModelId,
      );

      const durationMs = Date.now() - turnStartedAtMs;
      const runStatus = chatResult.runOutcome.status;
      const runSucceeded = runStatus !== "error" && runStatus !== "cancelled";

      if (!runSucceeded) {
        const runErrorDetail =
          chatResult.runOutcome.result?.trim() ||
          `Агент завершил run со статусом ${runStatus}`;
        const errorPayload = buildVoiceTurnErrorPayload(runErrorDetail);
        response.json({
          ok: false,
          sessionId,
          workspaceId: workspace.id,
          modelId: resolvedModelId,
          userText: userMessageText,
          durationMs,
          status: runStatus,
          runId: chatResult.runOutcome.runId,
          ...errorPayload,
        });
        return;
      }

      response.json({
        ok: true,
        sessionId,
        workspaceId: workspace.id,
        modelId: resolvedModelId,
        userText: userMessageText,
        assistantText: chatResult.assistantText,
        durationMs,
        status: runStatus,
        runId: chatResult.runOutcome.runId,
      });
    } catch (error) {
      await host.recoverWorkspaceAfterFailure(workspace.id, "voice turn failed", error);
      const normalizedMessage = error instanceof Error ? error.message : String(error);
      const errorPayload = buildVoiceTurnErrorPayload(normalizedMessage);
      response.status(500).json({
        ok: false,
        sessionId,
        workspaceId: workspace.id,
        userText: userMessageText,
        durationMs: Date.now() - turnStartedAtMs,
        status: "error",
        ...errorPayload,
      });
    } finally {
      host.releaseChatTurnLocks(sessionId, workspace.id);
    }
  });
}
