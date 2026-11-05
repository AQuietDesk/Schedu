import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { commands } from "@/lib/commands";
import type { Context, ContextInput } from "@/types";

const CONTEXTS_KEY = ["contexts"];

export function useContexts() {
  return useQuery({ queryKey: CONTEXTS_KEY, queryFn: commands.listContexts });
}

export function useCreateContext() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ContextInput) => commands.createContext(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CONTEXTS_KEY }),
  });
}

export function useUpdateContext() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (context: Context) => commands.updateContext(context),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CONTEXTS_KEY }),
  });
}
