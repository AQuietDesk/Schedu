import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { commands } from "@/lib/commands";
import type { NoteInput } from "@/types";

export function useNotesForContext(contextId: string | undefined) {
  return useQuery({
    queryKey: ["notes", contextId],
    queryFn: () => commands.listNotesForContext(contextId as string),
    enabled: !!contextId,
  });
}

export function useCreateNote(contextId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: NoteInput) => commands.createNote(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notes", contextId] }),
  });
}

export function useDeleteNote(contextId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => commands.deleteNote(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notes", contextId] }),
  });
}
