// test-weather.js
import { getWeather } from '../src/tools/weather-tool';

(async () => {
  try {
    const result = await getWeather('Santa Fe, Santa Fe');
    console.log('Clima en Santa Fe, Argentina:');
    console.log(result);
  } catch (error) {
    console.error('Error:', error);
  }
})();