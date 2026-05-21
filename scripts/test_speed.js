import * as http from 'node:http';
import * as fs from 'node:fs';

// Borrar sesión actual para que el contexto no crezca infinitamente
/*
try {
  fs.unlinkSync('.rei/sessions/current.json');
} catch(e) {}
 */

// Primero forzamos el modo ASK enviando un comando, para que la respuesta fluya token por token
const setModeData = JSON.stringify({
  messages: [{ role: 'user', content: '/mode ask' }]
});

const req1 = http.request({
  hostname: 'localhost',
  port: 3000,
  path: '/chat/completions',
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(setModeData) }
}, (res1) => {
  res1.on('end', () => {
    // Ahora enviamos el prompt real
    const data = JSON.stringify({
      messages: [{ role: 'user', content: 'Escribe un script hola mundo en python y explica que hace en 2 lineas.' }]
    });

    const options = {
      hostname: 'localhost',
      port: 3000,
      path: '/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };

    const startTime = Date.now();
    let firstTokenTime = null;
    let chunkCount = 0;
    let totalContentLength = 0;

    const req = http.request(options, (res) => {
      res.on('data', (chunk) => {
        const chunkStr = chunk.toString();
        if (!firstTokenTime) {
          firstTokenTime = Date.now();
          console.log(`⏱️ Time to First Token (TTFT): ${firstTokenTime - startTime} ms`);
        }

        const lines = chunkStr.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ') && line !== 'data: [DONE]') {
            try {
              const parsed = JSON.parse(line.substring(6));
              if (parsed.choices && parsed.choices[0] && parsed.choices[0].delta && parsed.choices[0].delta.content) {
                totalContentLength += parsed.choices[0].delta.content.length;
                chunkCount++;
              }
            } catch (e) { }
          }
        }
      });

      res.on('end', () => {
        const endTime = Date.now();
        const totalTime = endTime - startTime;
        const streamTime = endTime - firstTokenTime;

        const tokensPerSec = streamTime > 0 ? (chunkCount / (streamTime / 1000)).toFixed(2) : 0;

        console.log(`\n📊 Results:`);
        console.log(`- Total Time: ${totalTime} ms`);
        console.log(`- Stream Time (after first token): ${streamTime} ms`);
        console.log(`- Total Tokens (approx via chunks): ${chunkCount}`);
        console.log(`- Tokens per second: ${tokensPerSec} t/s`);
        console.log(`- Total Content Length: ${totalContentLength} chars`);
      });
    });

    req.on('error', console.error);
    req.write(data);
    req.end();
  });

  res1.resume(); // Consume data
});

req1.write(setModeData);
req1.end();

