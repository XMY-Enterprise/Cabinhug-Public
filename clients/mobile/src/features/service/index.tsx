/**
 * features/service — 售后服务界面（FL-20 `F-20-15` 指定的落点）。
 *
 * 目前承载拍照问诊：`capture.tsx` 拍照页，以及引导卡 / 报告页 / 追问。
 * 报告数据经 `api.ts` 只读，端上不解析回答文本。
 */
export { MobileCapture, CAPTURE_PARTS, type CapturePart, type MobileCaptureProps } from "./capture";
export { loadDiagnosis } from "./api";
export { DiagnosisCards, ObservationCard } from "./guided";
export { PromptCards, AskGroup, GuidanceCard, CaptureCard, type PromptCardsProps } from "./prompts";
export { composeAnswers, composeOutcome } from "./prompt-answers";
export { MobileDiagnosisReport, riskTitle } from "./report";
export { ReportPin, QuickReplies, QUICK_REPLIES, bookingPrompt } from "./followup";
export { diagnosisDemoView, DEMO_DIAGNOSIS_REPORT, DEMO_DIAGNOSIS_MESSAGES_GUIDED, DEMO_DIAGNOSIS_MESSAGES_FOLLOWUP } from "./demo";
export type { DiagnosisState, DiagnosisReport } from "./types";
