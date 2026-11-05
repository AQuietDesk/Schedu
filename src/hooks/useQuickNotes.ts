import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { commands } from "@/lib/commands";
import type { QuickNoteInput } from "@/types";

const QUICK_NOTES_KEY = ["quickNotes"];

export function useQuickNotes() {
  return useQuery({ queryKey: QUICK_NOTES_KEY, queryFn: commands.listQuickNotes });
}

export function useCreateQuickNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: QuickNoteInput) => commands.createQuickNote(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QUICK_NOTES_KEY }),
  });
}

export function useDeleteQuickNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => commands.deleteQuickNote(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QUICK_NOTES_KEY }),
  });
}
