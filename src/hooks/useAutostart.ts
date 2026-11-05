import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { commands } from "@/lib/commands";

const AUTOSTART_KEY = ["autostart", "enabled"];

export function useAutostartEnabled() {
  return useQuery({ queryKey: AUTOSTART_KEY, queryFn: commands.isAutostartEnabled });
}

export function useSetAutostart() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => (enabled ? commands.enableAutostart() : commands.disableAutostart()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: AUTOSTART_KEY }),
  });
}
