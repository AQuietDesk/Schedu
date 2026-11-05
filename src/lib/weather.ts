import { Cloud, CloudDrizzle, CloudFog, CloudLightning, CloudRain, CloudSnow, CloudSun, Sun } from "lucide-react";

// Open-Meteo: free, keyless, CORS-friendly — fetched directly from the
// renderer (this app's CSP is unrestricted, see tauri.conf.json) rather than
// through a Tauri command, since there's no auth/secret to keep server-side,
// unlike the Google integration.
const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

export interface DayForecast {
  date: string;
  code: number;
  high: number;
  low: number;
}

export interface WeatherData {
  locationLabel: string;
  currentTemp: number;
  currentCode: number;
  todayHigh: number;
  todayLow: number;
  upcoming: DayForecast[]; // next 3 days, not including today
}

// WMO weather codes (shared by Open-Meteo's `weather_code` field) bucketed
// into the icon/description Open-Meteo's own docs group them under.
const WEATHER_CODE_INFO: Record<number, { label: string; icon: typeof Sun }> = {
  0: { label: "Clear sky", icon: Sun },
  1: { label: "Mainly clear", icon: Sun },
  2: { label: "Partly cloudy", icon: CloudSun },
  3: { label: "Overcast", icon: Cloud },
  45: { label: "Fog", icon: CloudFog },
  48: { label: "Depositing rime fog", icon: CloudFog },
  51: { label: "Light drizzle", icon: CloudDrizzle },
  53: { label: "Drizzle", icon: CloudDrizzle },
  55: { label: "Dense drizzle", icon: CloudDrizzle },
  56: { label: "Freezing drizzle", icon: CloudDrizzle },
  57: { label: "Freezing drizzle", icon: CloudDrizzle },
  61: { label: "Slight rain", icon: CloudRain },
  63: { label: "Rain", icon: CloudRain },
  65: { label: "Heavy rain", icon: CloudRain },
  66: { label: "Freezing rain", icon: CloudRain },
  67: { label: "Freezing rain", icon: CloudRain },
  71: { label: "Slight snow", icon: CloudSnow },
  73: { label: "Snow", icon: CloudSnow },
  75: { label: "Heavy snow", icon: CloudSnow },
  77: { label: "Snow grains", icon: CloudSnow },
  80: { label: "Rain showers", icon: CloudRain },
  81: { label: "Rain showers", icon: CloudRain },
  82: { label: "Violent rain showers", icon: CloudRain },
  85: { label: "Snow showers", icon: CloudSnow },
  86: { label: "Snow showers", icon: CloudSnow },
  95: { label: "Thunderstorm", icon: CloudLightning },
  96: { label: "Thunderstorm with hail", icon: CloudLightning },
  99: { label: "Thunderstorm with hail", icon: CloudLightning },
};

export function weatherCodeInfo(code: number): { label: string; icon: typeof Sun } {
  return WEATHER_CODE_INFO[code] ?? { label: "Unknown", icon: Cloud };
}

async function geocode(location: string): Promise<{ lat: number; lon: number; label: string }> {
  const cityName = location.split(",")[0].trim();
  const url = new URL(GEOCODE_URL);
  url.searchParams.set("name", cityName);
  url.searchParams.set("count", "1");
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");

  const res = await fetch(url);
  if (!res.ok) throw new Error("Location lookup failed");
  const data = await res.json();
  const first = data.results?.[0];
  if (!first) throw new Error(`Couldn't find "${location}"`);
  return {
    lat: first.latitude,
    lon: first.longitude,
    label: first.admin1 ? `${first.name}, ${first.admin1}` : first.name,
  };
}

export async function fetchWeather(location: string): Promise<WeatherData> {
  const { lat, lon, label } = await geocode(location);

  const url = new URL(FORECAST_URL);
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("current", "temperature_2m,weather_code");
  url.searchParams.set("daily", "weather_code,temperature_2m_max,temperature_2m_min");
  url.searchParams.set("temperature_unit", "celsius");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("forecast_days", "4");

  const res = await fetch(url);
  if (!res.ok) throw new Error("Weather lookup failed");
  const data = await res.json();

  const days: string[] = data.daily.time;
  const codes: number[] = data.daily.weather_code;
  const highs: number[] = data.daily.temperature_2m_max;
  const lows: number[] = data.daily.temperature_2m_min;

  return {
    locationLabel: label,
    currentTemp: data.current.temperature_2m,
    currentCode: data.current.weather_code,
    todayHigh: highs[0],
    todayLow: lows[0],
    upcoming: days.slice(1).map((date, i) => ({
      date,
      code: codes[i + 1],
      high: highs[i + 1],
      low: lows[i + 1],
    })),
  };
}
