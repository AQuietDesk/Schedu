import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { commands } from "@/lib/commands";
import { usePreferences } from "@/hooks/usePreferences";
import type { IntakeDecision, ProModel } from "@/types";

const STATUS_KEY = ["pro", "status"];
const AI_KEY_KEY = ["pro", "aiKey"];
export const MODEL_PREF_KEY = "pro_ai_model";
export const DEFAULT_MODEL: ProModel = "claude-sonnet-5-5";

export const MODELS: { id: ProModel; label: string; hint: string }[] = [
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", hint: "Most accurate · about 6¢ a syllabus" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5", hint: "Cheapest · under 1¢ a syllabus" },
];

export function useProStatus() {
  return useQuery({ queryKey: STATUS_KEY, queryFn: commands.proStatus, staleTime: 60_000 });
}

/** True when this copy has the Pro code and the licence currently unlocks it. */
export function useProReady() {
  const { data } = useProStatus();
  return !!data && data.pro_build && (data.state === "active" || data.state === "grace");
}

function useStatusMutation<T>(fn: (arg: T) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => queryClient.invalidateQueries({ queryKey: STATUS_KEY }),
  });
}

export const useActivatePro = () => useStatusMutation((key: string) => commands.proActivate(key));
export const useRecheckPro = () => useStatusMutation(() => commands.proRecheck());
export const useDeactivatePro = () => useStatusMutation(() => commands.proDeactivate());
export const useInstallProUpgrade = () => useMutation({ mutationFn: () => commands.proInstallUpgrade() });

export function useAiKey() {
  return useQuery({ queryKey: AI_KEY_KEY, queryFn: commands.aiKeyStatus });
}

export function useSaveAiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (key: string) => commands.aiKeySave(key),
    onSuccess: (status) => queryClient.setQueryData(AI_KEY_KEY, status),
  });
}

export function useRemoveAiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => commands.aiKeyRemove(),
    onSuccess: (status) => queryClient.setQueryData(AI_KEY_KEY, status),
  });
}

export const useTestAiKey = () => useMutation({ mutationFn: (model: string) => commands.aiKeyTest(model) });

export function useProModel(): ProModel {
  const { data: prefs } = usePreferences();
  const value = prefs?.[MODEL_PREF_KEY];
  return MODELS.some((m) => m.id === value) ? (value as ProModel) : DEFAULT_MODEL;
}

export function useIntakeList(contextId: string | undefined) {
  return useQuery({
    queryKey: ["intake", "list", contextId],
    queryFn: () => commands.intakeList(contextId!),
    enabled: !!contextId,
  });
}

export function useIntakeBatch(batchId: string | undefined) {
  return useQuery({
    queryKey: ["intake", "batch", batchId],
    queryFn: () => commands.intakeGet(batchId!),
    enabled: !!batchId,
  });
}

function useIntakeMutation<T, R>(fn: (arg: T) => Promise<R>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["intake"] });
      queryClient.invalidateQueries({ queryKey: ["items"] });
      queryClient.invalidateQueries({ queryKey: ["contexts"] });
    },
  });
}

export const useIntakeExtract = () =>
  useIntakeMutation((a: { contextId: string; fileName: string; fileBase64: string }) =>
    commands.intakeExtract(a.contextId, a.fileName, a.fileBase64),
  );
export const useIntakeCommit = () =>
  useIntakeMutation((a: { batchId: string; decisions: IntakeDecision[]; apply: { instructor: boolean; grade_weights: boolean } }) =>
    commands.intakeCommit(a.batchId, a.decisions, a.apply),
  );
export const useIntakeUndo = () => useIntakeMutation((batchId: string) => commands.intakeUndo(batchId));
export const useIntakeDiscard = () => useIntakeMutation((batchId: string) => commands.intakeDiscard(batchId));

/** Tauri command errors arrive as plain strings. */
export function errorText(error: unknown): string {
  if (!error) return "";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}
