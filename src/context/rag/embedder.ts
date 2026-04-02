import { pipeline, env, FeatureExtractionPipeline } from '@xenova/transformers';

// Permitimos descargar el modelo remoto la primera vez
env.allowRemoteModels = true;
// Si tienes los modelos guardados localmente, puedes cambiar rutas de cache.
// env.localModelPath = '...';

const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';

let embedderPipeline: FeatureExtractionPipeline | null = null;

/**
 * Inicializa estáticamente el modelo ONNX en RAM.
 */
async function getEmbedder(): Promise<FeatureExtractionPipeline> {
  if (!embedderPipeline) {
    // La primera vez esto descargará ~22MB de pesos cuantizados y los guardará en la cache de node
    embedderPipeline = await pipeline('feature-extraction', MODEL_NAME, {
      quantized: true, // Optimizado para uso en memoria / CPU
    });
  }
  return embedderPipeline;
}

/**
 * Genera un vector (Embedding) para un texto dado.
 * @param text El texto (nodo AST, función, clase, o la pregunta del usuario)
 * @returns Un arreglo de números tipo Float (típicamente de 384 dimensiones)
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const extractor = await getEmbedder();
  
  // Se usa 'mean' pooling y 'normalize' generará vectores comparables mediante similitud coseno
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  
  return Array.from(output.data);
}
