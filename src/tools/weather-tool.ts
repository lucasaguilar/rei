export interface WeatherResult {
  location: string;
  temp: string;
  condition: string;
  humidity: string;
  wind: string;
}

/**
 * Formats a WeatherResult into a clean, readable markdown string.
 */
export function formatWeatherOutput(result: WeatherResult): string {
  return [
    `📍 **Location:** ${result.location.replace('📍 ', '')}`,
    `🌡️ **Temperature:** ${result.temp.replace('🌡️ ', '')}`,
    `☁️ **Condition:** ${result.condition.replace('☁️ ', '')}`,
    `💧 **Humidity:** ${result.humidity.replace('💧 ', '')}`,
    `💨 **Wind:** ${result.wind.replace('💨 ', '')}`
  ].join('\n');
}

/**
 * Fetches the current weather for a location via wttr.in.
 * @param location La ciudad o región (ej: "London", "Madrid").
 */
export async function getWeather(location: string): Promise<WeatherResult> {
  const url = `https://wttr.in/${encodeURIComponent(location)}?format=j1`;
  
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'rei-weather-tool/1.0',
        'Accept': 'application/json'
      }
    });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    
    const data = await response.json();

    if (!data.current_condition?.[0] || !data.nearest_area?.[0]) {
      throw new Error('Invalid weather data structure received.');
    }

    const current = data.current_condition[0];
    const area = data.nearest_area[0];

    return {
      location: `📍 ${area.areaName?.[0]?.value ?? area.region?.[0]?.value ?? location}, ${area.country?.[0]?.value ?? ''}`,
      temp: `🌡️ ${current.temp_C ?? 'N/A'}°C`,
      condition: `☁️ ${current.weatherDesc?.[0]?.value ?? 'Desconocido'}`,
      humidity: `💧 ${current.humidity ?? 'N/A'}%`,
      wind: `💨 ${current.windspeedKmph ?? current.wind_speed ?? 'N/A'} km/h`
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not fetch the weather for "${location}": ${msg}`);
  }
}