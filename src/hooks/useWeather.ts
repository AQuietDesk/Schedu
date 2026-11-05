import { useQuery } from "@tanstack/react-query";
import { fetchWeather } from "@/lib/weather";
import { usePreferences } from "@/hooks/usePreferences";
import { NOTIFICATION_DEFAULTS } from "@/lib/notificationDefaults";

const REFRESH_MS = 30 * 60 * 1000; // Open-Meteo's own forecast granularity is hourly at best — no need to poll faster

export function useWeather() {
  const { data: prefs } = usePreferences();
  const location = (prefs?.weather_location ?? NOTIFICATION_DEFAULTS.weather_location).trim();

  return useQuery({
    queryKey: ["weather", location],
    queryFn: () => fetchWeather(location),
    // No location set yet (the default): show no weather rather than guess a city.
    enabled: location !== "",
    staleTime: REFRESH_MS,
    refetchInterval: REFRESH_MS,
  });
}
